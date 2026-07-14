// One-off connection check. Run with: node --env-file=.env test-connection.mjs
// Prints only success/failure — never the secret values themselves.
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

let ok = true;

function check(name, cond, hint) {
  if (cond) {
    console.log(`[ok]   ${name}`);
  } else {
    ok = false;
    console.log(`[FAIL] ${name}${hint ? ' — ' + hint : ''}`);
  }
}

const { DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET } = process.env;

check('DATABASE_URL is set', DATABASE_URL && !DATABASE_URL.includes('PASTE-'), 'placeholder still in .env');
check('DATABASE_URL has no [YOUR-PASSWORD] left', DATABASE_URL && !DATABASE_URL.includes('[YOUR-PASSWORD]'), 'replace [YOUR-PASSWORD] with your real database password');
check('SUPABASE_URL is set', SUPABASE_URL && !SUPABASE_URL.includes('PASTE-'), 'placeholder still in .env');
check('SUPABASE_URL looks right', /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(SUPABASE_URL || ''), 'expected https://<project-id>.supabase.co');
check('SUPABASE_SERVICE_ROLE_KEY is set', SUPABASE_SERVICE_ROLE_KEY && !SUPABASE_SERVICE_ROLE_KEY.includes('PASTE-'), 'placeholder still in .env');
check('JWT_SECRET is set', JWT_SECRET && JWT_SECRET.length >= 32);

if (!ok) {
  console.log('\nFix the items above in server/.env and run again.');
  process.exit(1);
}

// --- Postgres ---
try {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const r = await client.query('SELECT current_database() AS db, version() AS v');
  console.log(`[ok]   Postgres connection — ${r.rows[0].db}, ${r.rows[0].v.split(' on ')[0]}`);
  await client.end();
} catch (err) {
  ok = false;
  console.log(`[FAIL] Postgres connection — ${err.message}`);
}

// --- Supabase Storage ---
try {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(error.message);
  console.log(`[ok]   Supabase Storage API — ${data.length} bucket(s) found`);
} catch (err) {
  ok = false;
  console.log(`[FAIL] Supabase Storage API — ${err.message}`);
}

console.log(ok ? '\nAll good — ready to migrate.' : '\nSome checks failed.');
process.exit(ok ? 0 : 1);
