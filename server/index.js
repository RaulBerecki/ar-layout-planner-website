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
import QRCode from 'qrcode';
import {
  pool,
  supabase,
  BUCKET,
  MAX_FILE_SIZE,
  initDb,
  seedDefaultRoles,
  generateInviteCode,
  generateLineCode,
  generateRecoveryCode,
  normalizeRecoveryCode,
} from './db.js';
import { PERMISSIONS, PERMISSION_KEYS, LINE_PERMISSION_KEYS } from './permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 4000;

const app = express();
// Render (and most hosts) put a proxy in front of the app. Without this, req.ip is the proxy's
// address, so every user would share one login-attempt counter in throttle() below.
app.set('trust proxy', 1);
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

// A users row joined with its organization role.
const USER_WITH_ROLE = `
  SELECT u.*, r.name AS role_name, r.permissions, r.is_builtin_admin
  FROM users u LEFT JOIN roles r ON r.id = u.role_id
`;

// Normalizes a row from USER_WITH_ROLE (or a query with the same role columns).
function toAuthUser(row) {
  return {
    id: row.id,
    username: row.username,
    org_id: row.org_id,
    role_id: row.role_id,
    role_name: row.role_name ?? null,
    isAdmin: row.is_builtin_admin === true,
    permissions: row.permissions ?? [],
  };
}

function hasPermission(user, key) {
  return user.isAdmin || user.permissions.includes(key);
}

function requirePermission(key) {
  return (req, res, next) =>
    hasPermission(req.user, key)
      ? next()
      : res.status(403).json({ error: "You don't have permission to do this" });
}

// Permissions a member has on one line: a per-line role replaces their organization role
// there. Administrators always keep full access, whatever per-line role they were given.
function linePermissions(user, overridePermissions) {
  if (user.isAdmin) return LINE_PERMISSION_KEYS;
  const granted = overridePermissions ?? user.permissions;
  return LINE_PERMISSION_KEYS.filter((key) => granted.includes(key));
}

function publicUser(user, orgRow) {
  return {
    id: user.id,
    username: user.username,
    organization: orgRow ? { id: orgRow.id, name: orgRow.name } : null,
    role: user.role_id ? { id: user.role_id, name: user.role_name } : null,
    permissions: user.isAdmin ? PERMISSION_KEYS : user.permissions,
  };
}

// Route ids arrive as strings; anything that isn't a positive integer is treated as "not found".
function idParam(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Always load fresh from DB so org membership and role changes apply immediately
    const { rows } = await pool.query(`${USER_WITH_ROLE} WHERE u.id = $1`, [payload.id]);
    if (rows.length === 0) return res.status(401).json({ error: 'Not authenticated' });
    req.user = toAuthUser(rows[0]);
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
      let roleId;
      if (!org) {
        const code = await generateInviteCode();
        const { rows } = await client.query(
          'INSERT INTO organizations (name, invite_code) VALUES ($1, $2) RETURNING *',
          [orgName.trim(), code]
        );
        org = rows[0];
        // Whoever creates the organization administers it.
        roleId = (await seedDefaultRoles(client, org.id)).admin;
      } else {
        // Joining with the invite code: the organization's default role (Viewer unless changed).
        roleId = org.default_role_id;
      }
      const hash = await bcrypt.hash(password, 10);
      // Shown to the user exactly once; only its hash is kept.
      const recoveryCode = generateRecoveryCode();
      const recoveryHash = await bcrypt.hash(normalizeRecoveryCode(recoveryCode), 10);
      const { rows: userRows } = await client.query(
        `INSERT INTO users (username, password_hash, org_id, recovery_code_hash, role_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [username.trim(), hash, org.id, recoveryHash, roleId]
      );
      await client.query('COMMIT');
      const { rows: created } = await pool.query(`${USER_WITH_ROLE} WHERE u.id = $1`, [
        userRows[0].id,
      ]);
      const user = toAuthUser(created[0]);
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
    // One round trip: the user, their organization and their role together.
    const { rows } = await pool.query(
      `SELECT u.*, o.name AS org_name, r.name AS role_name, r.permissions, r.is_builtin_admin
       FROM users u
       LEFT JOIN organizations o ON o.id = u.org_id
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.username = $1`,
      [username.trim()]
    );
    const row = rows[0];
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const user = toAuthUser(row);
    const org = row.org_name != null ? { id: row.org_id, name: row.org_name } : null;
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
    const organization = { id: org.id, name: org.name, member_count: countRows[0].n };
    // Anyone holding the invite code can join, so only member managers get to see it.
    if (hasPermission(req.user, 'members.manage')) {
      organization.invite_code = org.invite_code;
      organization.default_role_id = org.default_role_id;
    }
    res.json({ organization });
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

app.post('/api/files', requireAuth, requirePermission('models.upload'), (req, res, next) => {
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
    // Uploaders delete their own models; member managers can remove any model.
    const isOwner = file.user_id === req.user.id;
    if (!hasPermission(req.user, 'members.manage')) {
      if (!isOwner) return res.status(403).json({ error: 'You can only delete your own files' });
      if (!hasPermission(req.user, 'models.upload')) {
        return res.status(403).json({ error: "You don't have permission to delete models" });
      }
    }
    await pool.query('DELETE FROM files WHERE id = $1', [file.id]);
    const { error } = await supabase.storage.from(BUCKET).remove([file.storage_path]);
    if (error) console.error(`Storage cleanup failed for ${file.storage_path}: ${error.message}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Roles (custom per organization) ----------

app.get('/api/permissions', requireAuth, (req, res) => {
  res.json({ permissions: PERMISSIONS });
});

// Loads a role of the caller's organization, or answers 404.
async function getOrgRole(req, res, roleId) {
  const id = idParam(roleId);
  const { rows } = id
    ? await pool.query('SELECT * FROM roles WHERE id = $1 AND org_id = $2', [id, req.user.org_id])
    : { rows: [] };
  if (rows.length === 0) {
    res.status(404).json({ error: 'Role not found' });
    return null;
  }
  return rows[0];
}

// Validates { name, permissions }; with partial, missing fields are left out.
function parseRoleBody(body, { partial = false } = {}) {
  const result = {};
  if (body?.name !== undefined || !partial) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 40) return { error: 'Role name must be 1-40 characters' };
    result.name = name;
  }
  if (body?.permissions !== undefined || !partial) {
    const list = body?.permissions;
    if (!Array.isArray(list) || list.some((p) => !PERMISSION_KEYS.includes(p))) {
      return { error: 'Unknown permission' };
    }
    result.permissions = PERMISSION_KEYS.filter((p) => list.includes(p));
  }
  return result;
}

app.get('/api/roles', requireAuth, requirePermission('members.manage'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.name, r.permissions, r.is_builtin_admin,
              (o.default_role_id = r.id) AS is_default,
              (SELECT COUNT(*)::int FROM users u WHERE u.role_id = r.id) AS member_count,
              (SELECT COUNT(*)::int FROM line_roles lr WHERE lr.role_id = r.id) AS line_assignments
       FROM roles r JOIN organizations o ON o.id = r.org_id
       WHERE r.org_id = $1
       ORDER BY r.is_builtin_admin DESC, r.id`,
      [req.user.org_id]
    );
    const roles = rows.map((r) => ({
      ...r,
      permissions: r.is_builtin_admin ? PERMISSION_KEYS : r.permissions,
    }));
    res.json({ roles });
  } catch (err) {
    next(err);
  }
});

app.post('/api/roles', requireAuth, requirePermission('members.manage'), async (req, res, next) => {
  try {
    const body = parseRoleBody(req.body);
    if (body.error) return res.status(400).json({ error: body.error });
    const { rows } = await pool.query(
      'INSERT INTO roles (org_id, name, permissions) VALUES ($1, $2, $3) RETURNING id',
      [req.user.org_id, body.name, body.permissions]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A role with this name already exists' });
    }
    next(err);
  }
});

app.patch('/api/roles/:id', requireAuth, requirePermission('members.manage'), async (req, res, next) => {
  try {
    const role = await getOrgRole(req, res, req.params.id);
    if (!role) return;
    if (role.is_builtin_admin) {
      return res.status(400).json({ error: 'The Administrator role cannot be changed' });
    }
    const body = parseRoleBody(req.body, { partial: true });
    if (body.error) return res.status(400).json({ error: body.error });
    await pool.query(
      `UPDATE roles SET name = COALESCE($1, name), permissions = COALESCE($2, permissions)
       WHERE id = $3`,
      [body.name ?? null, body.permissions ?? null, role.id]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A role with this name already exists' });
    }
    next(err);
  }
});

app.delete('/api/roles/:id', requireAuth, requirePermission('members.manage'), async (req, res, next) => {
  try {
    const role = await getOrgRole(req, res, req.params.id);
    if (!role) return;
    if (role.is_builtin_admin) {
      return res.status(400).json({ error: 'The Administrator role cannot be deleted' });
    }
    const { rows: orgRows } = await pool.query(
      'SELECT default_role_id FROM organizations WHERE id = $1',
      [req.user.org_id]
    );
    if (orgRows[0].default_role_id === role.id) {
      return res.status(400).json({
        error: 'New members get this role. Choose another role for new members first.',
      });
    }
    const { rows: usage } = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM users WHERE role_id = $1)
            + (SELECT COUNT(*)::int FROM line_roles WHERE role_id = $1) AS n`,
      [role.id]
    );
    if (usage[0].n > 0) {
      return res.status(409).json({
        error: 'This role is still assigned. Give those members another role first.',
      });
    }
    await pool.query('DELETE FROM roles WHERE id = $1', [role.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Role given to people who join with the invite code.
app.put('/api/org/default-role', requireAuth, requirePermission('members.manage'), async (req, res, next) => {
  try {
    const role = await getOrgRole(req, res, req.body?.roleId);
    if (!role) return;
    if (role.is_builtin_admin) {
      return res.status(400).json({ error: "New members can't become Administrators automatically" });
    }
    await pool.query('UPDATE organizations SET default_role_id = $1 WHERE id = $2', [
      role.id,
      req.user.org_id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Members ----------

// Loads a member of the caller's organization (with their role), or answers 404.
async function getOrgMember(req, res, userId) {
  const id = idParam(userId);
  const { rows } = id
    ? await pool.query(`${USER_WITH_ROLE} WHERE u.id = $1 AND u.org_id = $2`, [id, req.user.org_id])
    : { rows: [] };
  if (rows.length === 0) {
    res.status(404).json({ error: 'Member not found' });
    return null;
  }
  return toAuthUser(rows[0]);
}

app.get('/api/members', requireAuth, requirePermission('members.manage'), async (req, res, next) => {
  try {
    const { rows: members } = await pool.query(
      'SELECT id, username, role_id, created_at FROM users WHERE org_id = $1 ORDER BY id',
      [req.user.org_id]
    );
    const { rows: lineRoles } = await pool.query(
      `SELECT lr.user_id, lr.line_id, lr.role_id
       FROM line_roles lr JOIN production_lines l ON l.id = lr.line_id
       WHERE l.org_id = $1`,
      [req.user.org_id]
    );
    res.json({
      members: members.map((m) => ({
        ...m,
        // { lineId: roleId } for the lines where this member has a different role
        line_roles: Object.fromEntries(
          lineRoles.filter((lr) => lr.user_id === m.id).map((lr) => [lr.line_id, lr.role_id])
        ),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Changes a member's organization role.
app.put('/api/members/:id/role', requireAuth, requirePermission('members.manage'), async (req, res, next) => {
  try {
    const member = await getOrgMember(req, res, req.params.id);
    if (!member) return;
    const role = await getOrgRole(req, res, req.body?.roleId);
    if (!role) return;
    // Never leave the organization without an Administrator.
    if (member.isAdmin && !role.is_builtin_admin) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.org_id = $1 AND r.is_builtin_admin`,
        [req.user.org_id]
      );
      if (rows[0].n <= 1) {
        return res.status(400).json({ error: 'The organization needs at least one Administrator' });
      }
    }
    await pool.query('UPDATE users SET role_id = $1 WHERE id = $2', [role.id, member.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Sets a member's role on one line ({ roleId }), or removes it ({ roleId: null }) so the
// organization role applies there again.
app.put(
  '/api/members/:id/lines/:lineId',
  requireAuth,
  requirePermission('members.manage'),
  async (req, res, next) => {
    try {
      const member = await getOrgMember(req, res, req.params.id);
      if (!member) return;
      const line = await getOrgLine(req, res, req.params.lineId);
      if (!line) return;
      if (req.body?.roleId == null) {
        await pool.query('DELETE FROM line_roles WHERE line_id = $1 AND user_id = $2', [
          line.id,
          member.id,
        ]);
        return res.json({ ok: true });
      }
      const role = await getOrgRole(req, res, req.body.roleId);
      if (!role) return;
      await pool.query(
        `INSERT INTO line_roles (line_id, user_id, role_id) VALUES ($1, $2, $3)
         ON CONFLICT (line_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id`,
        [line.id, member.id, role.id]
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// ---------- Production lines ----------

// Loads a line of the caller's organization, or answers 404.
async function getOrgLine(req, res, lineId) {
  const id = idParam(lineId);
  const { rows } = id
    ? await pool.query('SELECT * FROM production_lines WHERE id = $1 AND org_id = $2', [
        id,
        req.user.org_id,
      ])
    : { rows: [] };
  if (rows.length === 0) {
    res.status(404).json({ error: 'Line not found' });
    return null;
  }
  return rows[0];
}

// The caller's permissions on one line (their per-line role if set, else their organization role).
async function lineAccess(user, lineId) {
  const { rows } = await pool.query(
    `SELECT r.permissions FROM line_roles lr JOIN roles r ON r.id = lr.role_id
     WHERE lr.line_id = $1 AND lr.user_id = $2`,
    [lineId, user.id]
  );
  return linePermissions(user, rows[0]?.permissions);
}

// Validates { name, markerSizeCm }; with partial, missing fields are left out.
function parseLineBody(body, { partial = false } = {}) {
  const result = {};
  if (body?.name !== undefined || !partial) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 80) return { error: 'Line name must be 1-80 characters' };
    result.name = name;
  }
  if (body?.markerSizeCm !== undefined) {
    const size = Number(body.markerSizeCm);
    if (!Number.isFinite(size) || size < 5 || size > 100) {
      return { error: 'QR code size must be between 5 and 100 cm' };
    }
    result.markerSizeCm = Math.round(size * 10) / 10;
  }
  return result;
}

// What a line's QR code contains. Scanned with a phone camera it opens the line on this
// website; the AR app recognises the printed image and uses the code at the end.
// Set PUBLIC_URL so printed codes don't depend on which address the site was opened from.
function lineUrl(req, code) {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/line/${code}`;
}

app.get('/api/lines', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.name, l.code, l.marker_size_cm::float8 AS marker_size_cm, l.created_at,
              r.name AS line_role_name, r.permissions AS line_role_permissions
       FROM production_lines l
       LEFT JOIN line_roles lr ON lr.line_id = l.id AND lr.user_id = $2
       LEFT JOIN roles r ON r.id = lr.role_id
       WHERE l.org_id = $1
       ORDER BY l.created_at, l.id`,
      [req.user.org_id, req.user.id]
    );
    // Line and member managers see every line, so they can manage it or assign roles on it.
    const seesAll = hasPermission(req.user, 'lines.manage') || hasPermission(req.user, 'members.manage');
    const lines = rows
      .map(({ line_role_name, line_role_permissions, ...line }) => ({
        ...line,
        role: req.user.isAdmin || !line_role_name ? req.user.role_name : line_role_name,
        permissions: linePermissions(req.user, line_role_permissions),
      }))
      .filter((line) => seesAll || line.permissions.includes('line.view'));
    res.json({ lines });
  } catch (err) {
    next(err);
  }
});

app.post('/api/lines', requireAuth, requirePermission('lines.manage'), async (req, res, next) => {
  try {
    const body = parseLineBody(req.body);
    if (body.error) return res.status(400).json({ error: body.error });
    const code = await generateLineCode();
    const { rows } = await pool.query(
      `INSERT INTO production_lines (org_id, name, code, marker_size_cm, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.user.org_id, body.name, code, body.markerSizeCm ?? 18, req.user.id]
    );
    res.status(201).json({ id: rows[0].id, code });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/lines/:id', requireAuth, requirePermission('lines.manage'), async (req, res, next) => {
  try {
    const line = await getOrgLine(req, res, req.params.id);
    if (!line) return;
    const body = parseLineBody(req.body, { partial: true });
    if (body.error) return res.status(400).json({ error: body.error });
    await pool.query(
      `UPDATE production_lines
       SET name = COALESCE($1, name), marker_size_cm = COALESCE($2, marker_size_cm)
       WHERE id = $3`,
      [body.name ?? null, body.markerSizeCm ?? null, line.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/lines/:id', requireAuth, requirePermission('lines.manage'), async (req, res, next) => {
  try {
    const line = await getOrgLine(req, res, req.params.id);
    if (!line) return;
    await pool.query('DELETE FROM production_lines WHERE id = $1', [line.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PNG of the line's QR code. The same image is printed at marker_size_cm and registered in the
// AR app at that physical size, so the app can recognise it and anchor layouts to it.
app.get('/api/lines/:id/qr.png', requireAuth, async (req, res, next) => {
  try {
    const line = await getOrgLine(req, res, req.params.id);
    if (!line) return;
    const permissions = await lineAccess(req.user, line.id);
    if (!permissions.includes('line.view') && !hasPermission(req.user, 'lines.manage')) {
      return res.status(403).json({ error: "You don't have access to this line" });
    }
    const png = await QRCode.toBuffer(lineUrl(req, line.code), {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 1024,
    });
    res.type('png').set('Cache-Control', 'private, max-age=3600').send(png);
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
