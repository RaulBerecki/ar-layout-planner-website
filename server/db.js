import pg from 'pg';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_ROLES } from './permissions.js';

const REQUIRED_ENV = ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET'];
for (const name of REQUIRED_ENV) {
  if (!process.env[name]) {
    console.error(
      `Missing required environment variable: ${name}\n` +
        'Start the server with: node --env-file=.env index.js (or npm run dev)'
    );
    process.exit(1);
  }
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const BUCKET = 'models';
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB (Supabase free tier per-file cap)

// Database schema. Every statement is idempotent, so it runs safely on each start.
export const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS organizations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      org_id INTEGER NOT NULL REFERENCES organizations(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS files (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      org_id INTEGER NOT NULL REFERENCES organizations(id),
      original_name TEXT NOT NULL,
      storage_path TEXT NOT NULL UNIQUE,
      size_bytes BIGINT NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_files_org ON files (org_id);
    CREATE INDEX IF NOT EXISTS idx_users_org ON users (org_id);

    ALTER TABLE files ADD COLUMN IF NOT EXISTS thumbnail TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_code_hash TEXT;

    -- Roles: custom per organization, each a set of permission keys (see permissions.js)
    CREATE TABLE IF NOT EXISTS roles (
      id SERIAL PRIMARY KEY,
      org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      permissions TEXT[] NOT NULL DEFAULT '{}',
      is_builtin_admin BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (org_id, name)
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id);
    -- Role given to people who join with the invite code
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_role_id INTEGER REFERENCES roles(id);

    -- Production lines, each identified in the physical world by a printed QR code
    CREATE TABLE IF NOT EXISTS production_lines (
      id SERIAL PRIMARY KEY,
      org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      marker_size_cm NUMERIC(5,1) NOT NULL DEFAULT 18.0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_lines_org ON production_lines (org_id);

    -- Per-line role: replaces the member's organization role on that one line
    CREATE TABLE IF NOT EXISTS line_roles (
      line_id INTEGER NOT NULL REFERENCES production_lines(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES roles(id),
      PRIMARY KEY (line_id, user_id)
    );

    -- Only this server (service key) may touch these tables; block the public anon key.
    ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
    ALTER TABLE production_lines ENABLE ROW LEVEL SECURITY;
    ALTER TABLE line_roles ENABLE ROW LEVEL SECURITY;
`;

export async function initDb() {
  // Schema and data migration run in one transaction: all of it applies, or none of it.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(SCHEMA_SQL);
    await migrateRoles(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(`Supabase Storage: ${error.message}`);
  if (!buckets.some((b) => b.name === BUCKET)) {
    const { error: createErr } = await supabase.storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: MAX_FILE_SIZE,
    });
    if (createErr) throw new Error(`Supabase Storage: ${createErr.message}`);
    console.log(`Created private storage bucket "${BUCKET}"`);
  }
}

/**
 * Creates the default roles for an organization and makes Viewer the role for new members.
 * Returns the new role ids by key: { admin, editor, viewer }.
 */
export async function seedDefaultRoles(client, orgId) {
  const ids = {};
  for (const role of DEFAULT_ROLES) {
    const { rows } = await client.query(
      `INSERT INTO roles (org_id, name, permissions, is_builtin_admin)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [orgId, role.name, role.permissions, role.builtinAdmin === true]
    );
    ids[role.key] = rows[0].id;
  }
  await client.query('UPDATE organizations SET default_role_id = $1 WHERE id = $2', [
    ids.viewer,
    orgId,
  ]);
  return ids;
}

/**
 * One-time upgrade for organizations created before roles existed: give them the default
 * roles, make the oldest account Administrator and everyone else Editor (so existing members
 * keep being able to upload models). Safe to run on every start. Runs on the caller's
 * client so it shares the caller's transaction.
 */
export async function migrateRoles(client) {
  const { rows: orgs } = await client.query(
    `SELECT o.id FROM organizations o
     WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.org_id = o.id)`
  );
  for (const { id: orgId } of orgs) {
    const roles = await seedDefaultRoles(client, orgId);
    await client.query(
      `UPDATE users
       SET role_id = CASE WHEN id = (SELECT MIN(id) FROM users WHERE org_id = $1) THEN $2::int ELSE $3::int END
       WHERE org_id = $1 AND role_id IS NULL`,
      [orgId, roles.admin, roles.editor]
    );
    console.log(`Added default roles to organization ${orgId}`);
  }

  // Safety net: any member still without a role gets the organization's default role.
  await client.query(
    `UPDATE users u SET role_id = o.default_role_id
     FROM organizations o
     WHERE u.org_id = o.id AND u.role_id IS NULL AND o.default_role_id IS NOT NULL`
  );
}

// Unambiguous alphabet shared by invite and recovery codes (no 0/O, 1/I)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(length) {
  return Array.from(crypto.randomBytes(length))
    .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
    .join('');
}

/**
 * One-time account recovery code, e.g. "K7QP-2MRX-9HTB-4WLN".
 * 16 characters from a 32-symbol alphabet = 80 bits of entropy.
 */
export function generateRecoveryCode() {
  return (randomCode(16).match(/.{4}/g) || []).join('-');
}

/** Codes are compared case-insensitively and ignoring dashes/spaces. */
export function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Unique code that identifies a production line, e.g. "L7QP2MRX9H" (used in its QR code). */
export async function generateLineCode() {
  for (;;) {
    const code = 'L' + randomCode(9);
    const { rows } = await pool.query('SELECT 1 FROM production_lines WHERE code = $1', [code]);
    if (rows.length === 0) return code;
  }
}

export async function generateInviteCode() {
  // 8 chars, unambiguous alphabet (no 0/O, 1/I)
  for (;;) {
    const code = randomCode(8);
    const { rows } = await pool.query(
      'SELECT 1 FROM organizations WHERE invite_code = $1',
      [code]
    );
    if (rows.length === 0) return code;
  }
}
