import express from 'express';
import cors from 'cors';
// Native bcrypt: several times faster than bcryptjs and its async calls run off the main thread.
// It reads the $2a$ hashes created earlier with bcryptjs, so existing passwords keep working.
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  pool,
  supabase,
  BUCKET,
  MAX_FILE_SIZE,
  initDb,
  generateInviteCode,
  generateRecoveryCode,
  normalizeRecoveryCode,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' })); // thumbnails arrive as data URLs

const MAX_THUMBNAIL_LENGTH = 200_000; // ~200 KB data URL

function validThumbnail(thumbnail) {
  return (
    typeof thumbnail === 'string' &&
    thumbnail.startsWith('data:image/') &&
    thumbnail.length <= MAX_THUMBNAIL_LENGTH
  );
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- Brute-force throttling ----------
// In-memory counter: enough for a single-instance deployment. A multi-instance
// setup would need a shared store (Redis) instead.
const attempts = new Map();
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function throttle(maxAttempts) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry || now > entry.resetAt) {
      attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
      return next();
    }
    if (entry.count >= maxAttempts) {
      const minutes = Math.ceil((entry.resetAt - now) / 60000);
      return res.status(429).json({
        error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      });
    }
    entry.count += 1;
    next();
  };
}

// Forget counters for keys whose window has passed
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (now > entry.resetAt) attempts.delete(key);
  }
}, ATTEMPT_WINDOW_MS).unref();

// ---------- Auth ----------

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: '7d',
  });
}

function publicUser(userRow, orgRow) {
  return {
    id: userRow.id,
    username: userRow.username,
    organization: orgRow ? { id: orgRow.id, name: orgRow.name } : null,
  };
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Always load fresh from DB so org membership is current
    const { rows } = await pool.query(
      'SELECT id, username, org_id FROM users WHERE id = $1',
      [payload.id]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Not authenticated' });
    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    next(err);
  }
}

app.post('/api/register', throttle(20), async (req, res, next) => {
  try {
    const { username, password, orgMode, orgName, inviteCode } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (username.trim().length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    let org = null;
    if (orgMode === 'join') {
      if (!inviteCode || !inviteCode.trim()) {
        return res.status(400).json({ error: 'Invite code is required to join an organization' });
      }
      const { rows } = await pool.query(
        'SELECT * FROM organizations WHERE invite_code = $1',
        [inviteCode.trim().toUpperCase()]
      );
      if (rows.length === 0) {
        return res.status(400).json({ error: 'Invalid invite code' });
      }
      org = rows[0];
    } else if (orgMode === 'create') {
      if (!orgName || !orgName.trim()) {
        return res.status(400).json({ error: 'Organization name is required' });
      }
    } else {
      return res.status(400).json({ error: 'Choose to create or join an organization' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (!org) {
        const code = await generateInviteCode();
        const { rows } = await client.query(
          'INSERT INTO organizations (name, invite_code) VALUES ($1, $2) RETURNING *',
          [orgName.trim(), code]
        );
        org = rows[0];
      }
      const hash = await bcrypt.hash(password, 10);
      // Shown to the user exactly once; only its hash is kept.
      const recoveryCode = generateRecoveryCode();
      const recoveryHash = await bcrypt.hash(normalizeRecoveryCode(recoveryCode), 10);
      const { rows: userRows } = await client.query(
        `INSERT INTO users (username, password_hash, org_id, recovery_code_hash)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [username.trim(), hash, org.id, recoveryHash]
      );
      await client.query('COMMIT');
      const user = userRows[0];
      res.status(201).json({
        token: signToken(user),
        user: publicUser(user, org),
        recovery_code: recoveryCode,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Username is already taken' });
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

app.post('/api/login', throttle(15), async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    // One round trip: the user and their organization together.
    const { rows } = await pool.query(
      `SELECT u.*, o.name AS org_name
       FROM users u LEFT JOIN organizations o ON o.id = u.org_id
       WHERE u.username = $1`,
      [username.trim()]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const org = user.org_name != null ? { id: user.org_id, name: user.org_name } : null;
    res.json({ token: signToken(user), user: publicUser(user, org) });
  } catch (err) {
    next(err);
  }
});

// Password reset with the recovery code issued at registration. The code is
// single-use: a successful reset replaces it with a fresh one.
app.post('/api/recover', throttle(10), async (req, res, next) => {
  try {
    const { username, recoveryCode, newPassword } = req.body || {};
    if (!username || !recoveryCode || !newPassword) {
      return res
        .status(400)
        .json({ error: 'Username, recovery code and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [
      username.trim(),
    ]);
    const user = rows[0];
    const supplied = normalizeRecoveryCode(recoveryCode);
    // One generic message so this cannot be used to discover usernames
    const invalid = { error: 'Invalid username or recovery code' };
    if (!user || !user.recovery_code_hash) return res.status(400).json(invalid);
    if (!(await bcrypt.compare(supplied, user.recovery_code_hash))) {
      return res.status(400).json(invalid);
    }

    const nextCode = generateRecoveryCode();
    await pool.query(
      'UPDATE users SET password_hash = $1, recovery_code_hash = $2 WHERE id = $3',
      [
        await bcrypt.hash(newPassword, 10),
        await bcrypt.hash(normalizeRecoveryCode(nextCode), 10),
        user.id,
      ]
    );
    res.json({ ok: true, recovery_code: nextCode });
  } catch (err) {
    next(err);
  }
});

app.get('/api/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM organizations WHERE id = $1', [
      req.user.org_id,
    ]);
    res.json({ user: publicUser(req.user, rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/org', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM organizations WHERE id = $1', [
      req.user.org_id,
    ]);
    if (rows.length === 0) return res.status(404).json({ error: 'Organization not found' });
    const org = rows[0];
    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM users WHERE org_id = $1',
      [org.id]
    );
    res.json({
      organization: {
        id: org.id,
        name: org.name,
        invite_code: org.invite_code,
        member_count: countRows[0].n,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Files (stored in Supabase Storage, scoped to the user's organization) ----------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.glb') cb(null, true);
    else cb(new Error('Only .glb files are allowed'));
  },
});

const FILE_SELECT = `
  SELECT f.id, f.original_name, f.size_bytes::int AS size_bytes, f.uploaded_at,
         f.thumbnail, u.username AS uploaded_by
  FROM files f JOIN users u ON u.id = f.user_id
`;

app.get('/api/files', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `${FILE_SELECT} WHERE f.org_id = $1 ORDER BY f.uploaded_at DESC, f.id DESC`,
      [req.user.org_id]
    );
    res.json({ files: rows });
  } catch (err) {
    next(err);
  }
});

app.post('/api/files', requireAuth, (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file provided' });

      const storagePath = `org-${req.user.org_id}/${crypto.randomUUID()}.glb`;
      const { error: uploadErr } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, req.file.buffer, { contentType: 'model/gltf-binary' });
      if (uploadErr) {
        return res.status(502).json({ error: `Storage upload failed: ${uploadErr.message}` });
      }

      const thumbnail = validThumbnail(req.body?.thumbnail) ? req.body.thumbnail : null;
      const { rows } = await pool.query(
        `INSERT INTO files (user_id, org_id, original_name, storage_path, size_bytes, thumbnail)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.user.id, req.user.org_id, req.file.originalname, storagePath, req.file.size, thumbnail]
      );
      const { rows: fileRows } = await pool.query(`${FILE_SELECT} WHERE f.id = $1`, [
        rows[0].id,
      ]);
      res.status(201).json({ file: fileRows[0] });
    } catch (e) {
      next(e);
    }
  });
});

async function getOrgFile(req, res) {
  const { rows } = await pool.query('SELECT * FROM files WHERE id = $1', [req.params.id]);
  const file = rows[0];
  if (!file || file.org_id !== req.user.org_id) {
    res.status(404).json({ error: 'File not found' });
    return null;
  }
  return file;
}

// Returns a short-lived signed URL so the browser downloads straight from
// Supabase's CDN instead of proxying the bytes through this server.
app.get('/api/files/:id/url', requireAuth, async (req, res, next) => {
  try {
    const file = await getOrgFile(req, res);
    if (!file) return;
    const asAttachment = req.query.download === '1';
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(
        file.storage_path,
        300,
        asAttachment ? { download: file.original_name } : undefined
      );
    if (error) {
      return res.status(502).json({ error: `Storage error: ${error.message}` });
    }
    res.json({ url: data.signedUrl, expires_in: 300 });
  } catch (err) {
    next(err);
  }
});

// Backfill: lets the viewer save a thumbnail for files uploaded before
// thumbnails existed (any member of the owning organization).
app.post('/api/files/:id/thumbnail', requireAuth, async (req, res, next) => {
  try {
    const file = await getOrgFile(req, res);
    if (!file) return;
    const { thumbnail } = req.body || {};
    if (!validThumbnail(thumbnail)) {
      return res.status(400).json({ error: 'Invalid thumbnail' });
    }
    await pool.query('UPDATE files SET thumbnail = $1 WHERE id = $2', [thumbnail, file.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/files/:id', requireAuth, async (req, res, next) => {
  try {
    const file = await getOrgFile(req, res);
    if (!file) return;
    if (file.user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete your own files' });
    }
    await pool.query('DELETE FROM files WHERE id = $1', [file.id]);
    const { error } = await supabase.storage.from(BUCKET).remove([file.storage_path]);
    if (error) console.error(`Storage cleanup failed for ${file.storage_path}: ${error.message}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Static frontend (production) ----------
// When the client has been built (client/dist exists), serve it from this
// server so the whole app runs as a single deployment.
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
