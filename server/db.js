import pg from 'pg';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

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

export async function initDb() {
  await pool.query(`
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
  `);

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

export async function generateInviteCode() {
  // 8 chars, unambiguous alphabet (no 0/O, 1/I)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const code = Array.from(crypto.randomBytes(8))
      .map((b) => alphabet[b % alphabet.length])
      .join('');
    const { rows } = await pool.query(
      'SELECT 1 FROM organizations WHERE invite_code = $1',
      [code]
    );
    if (rows.length === 0) return code;
  }
}
