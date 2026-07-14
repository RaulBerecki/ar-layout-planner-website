// One-off migration: copies organizations, users and files from the old
// SQLite database (app.db + uploads/) into Supabase Postgres + Storage.
// Run with: node --env-file=.env migrate-from-sqlite.mjs
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, supabase, BUCKET, initDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await initDb();

const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
if (rows[0].n > 0) {
  console.log('Postgres already contains users — skipping migration to avoid duplicates.');
  process.exit(0);
}

const sqlite = new Database(path.join(__dirname, 'app.db'), { readonly: true });
const orgs = sqlite.prepare('SELECT * FROM organizations').all();
const users = sqlite.prepare('SELECT * FROM users').all();
const files = sqlite.prepare('SELECT * FROM files').all();

const orgMap = new Map();
for (const o of orgs) {
  const r = await pool.query(
    'INSERT INTO organizations (name, invite_code, created_at) VALUES ($1, $2, $3) RETURNING id',
    [o.name, o.invite_code, o.created_at + 'Z']
  );
  orgMap.set(o.id, r.rows[0].id);
  console.log(`org: ${o.name} (invite ${o.invite_code})`);
}

const userMap = new Map();
for (const u of users) {
  const r = await pool.query(
    'INSERT INTO users (username, password_hash, org_id, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [u.username, u.password_hash, orgMap.get(u.org_id), u.created_at + 'Z']
  );
  userMap.set(u.id, r.rows[0].id);
  console.log(`user: ${u.username}`);
}

for (const f of files) {
  const localPath = path.join(__dirname, 'uploads', f.stored_name);
  if (!fs.existsSync(localPath)) {
    console.log(`SKIP (missing on disk): ${f.original_name}`);
    continue;
  }
  const newOrgId = orgMap.get(f.org_id);
  const storagePath = `org-${newOrgId}/${f.stored_name}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, fs.readFileSync(localPath), { contentType: 'model/gltf-binary' });
  if (error) {
    console.log(`FAILED to upload ${f.original_name}: ${error.message}`);
    continue;
  }
  await pool.query(
    `INSERT INTO files (user_id, org_id, original_name, storage_path, size_bytes, uploaded_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userMap.get(f.user_id), newOrgId, f.original_name, storagePath, f.size_bytes, f.uploaded_at + 'Z']
  );
  console.log(`file: ${f.original_name} -> ${storagePath}`);
}

console.log('Migration complete.');
process.exit(0);
