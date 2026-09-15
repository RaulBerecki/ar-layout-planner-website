// Owner-only account tool. Run locally where server/.env exists:
//
//   node --env-file=.env admin-reset.mjs --list
//   node --env-file=.env admin-reset.mjs <username>              (random password)
//   node --env-file=.env admin-reset.mjs <username> <password>
//
// Prints the new password and recovery code once. This is the last resort when
// both the password and the recovery code are lost.
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { pool, initDb, generateRecoveryCode, normalizeRecoveryCode } from './db.js';

const [arg1, arg2] = process.argv.slice(2);

// Makes sure the schema (including recovery_code_hash) exists
await initDb();

if (!arg1 || arg1 === '--help' || arg1 === '-h') {
  console.log(`Usage:
  node --env-file=.env admin-reset.mjs --list
  node --env-file=.env admin-reset.mjs <username> [newPassword]`);
  process.exit(arg1 ? 0 : 1);
}

if (arg1 === '--list') {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, o.name AS org,
            (u.recovery_code_hash IS NOT NULL) AS has_recovery_code
     FROM users u JOIN organizations o ON o.id = u.org_id ORDER BY u.id`
  );
  for (const r of rows) {
    console.log(
      `${String(r.id).padStart(3)}  ${r.username.padEnd(16)} ${r.org.padEnd(24)} ` +
        `recovery code: ${r.has_recovery_code ? 'set' : 'NOT SET'}`
    );
  }
  console.log(`\n${rows.length} user(s)`);
  await pool.end();
  process.exit(0);
}

const username = arg1.trim();
const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
if (rows.length === 0) {
  console.error(`No user named "${username}". Run with --list to see all accounts.`);
  await pool.end();
  process.exit(1);
}

// Readable random password when none is supplied, e.g. "brisk-cobalt-4827"
function randomPassword() {
  const adjectives = ['brisk', 'calm', 'bright', 'swift', 'quiet', 'solid', 'keen', 'brave'];
  const nouns = ['cobalt', 'harbor', 'granite', 'meadow', 'lantern', 'cedar', 'falcon', 'ember'];
  const pick = (list) => list[crypto.randomInt(list.length)];
  return `${pick(adjectives)}-${pick(nouns)}-${crypto.randomInt(1000, 9999)}`;
}

const password = arg2 || randomPassword();
if (password.length < 6) {
  console.error('Password must be at least 6 characters.');
  await pool.end();
  process.exit(1);
}

const recoveryCode = generateRecoveryCode();
await pool.query(
  'UPDATE users SET password_hash = $1, recovery_code_hash = $2 WHERE id = $3',
  [
    bcrypt.hashSync(password, 10),
    bcrypt.hashSync(normalizeRecoveryCode(recoveryCode), 10),
    rows[0].id,
  ]
);

console.log(`Account "${username}" updated.

  password:      ${password}
  recovery code: ${recoveryCode}

Store the recovery code somewhere safe — it is shown only now and lets you
reset this password from the login page without this script.`);
await pool.end();
