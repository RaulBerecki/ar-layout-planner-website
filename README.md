# AR Manufacturing Layout Planner

Web app for managing GLB 3D models: register/log in, browse your
organization's model library, upload, preview in 3D, download and delete
files. The built-in viewer (three.js) opens any GLB in a modal with orbit
controls — drag to rotate, scroll to zoom, right-drag to pan.

Accounts belong to an **organization** (a company, department, team…). When
registering you either create a new organization or join an existing one with
its invite code. All files are shared within the organization and invisible to
other organizations. The invite code is shown on the main menu so members can
invite colleagues.

## Structure

- `client/` — React frontend (Vite + React Router + three.js viewer)
- `server/` — Express API with Supabase Postgres (`pg`), Supabase Storage,
  JWT auth, multer uploads

GLB binaries are stored in a **private Supabase Storage bucket** (`models`);
their metadata (name, size, uploader, organization, timestamp) lives in
**Supabase Postgres**. The server needs a `server/.env` file — copy
`server/.env.example` and fill in your Supabase project's values. The tables
and the bucket are created automatically on first start.

`server/app.db` and `server/uploads/` are the old local SQLite storage, kept
only as a backup; `migrate-from-sqlite.mjs` was the one-off script that copied
them to Supabase.

## Running locally

Terminal 1 — API server (port 4000):

```
cd server
npm install
npm run dev
```

Terminal 2 — frontend (port 5173 by default; `/api` is proxied to :4000):

```
cd client
npm install
npm run dev
```

Then open the URL Vite prints, register an account, and start uploading
`.glb` files (max 50 MB each — the Supabase free-tier per-file cap).

## API overview

| Method | Route                     | Auth | Description                     |
| ------ | ------------------------- | ---- | ------------------------------- |
| POST   | `/api/register`           | –    | Create account + create/join org, returns JWT |
| POST   | `/api/login`              | –    | Log in, returns JWT             |
| POST   | `/api/recover`            | –    | Reset password with recovery code |
| GET    | `/api/me`                 | ✔    | Current user + organization     |
| GET    | `/api/org`                | ✔    | Org name, invite code, members  |
| GET    | `/api/files`              | ✔    | List the org's files            |
| POST   | `/api/files`              | ✔    | Upload one file (`file` field)  |
| GET    | `/api/files/:id/url`      | ✔    | Signed URL for preview/download |
| POST   | `/api/files/:id/thumbnail`| ✔    | Save a generated thumbnail      |
| DELETE | `/api/files/:id`          | ✔    | Delete own file                 |

`POST /api/register` body: `{ username, password, orgMode: "create" | "join",
orgName?, inviteCode? }`.

## Forgotten passwords

Accounts have no email address, so password reset uses a **recovery code**
instead of a reset link. Registration returns a one-time code (e.g.
`K7QP-2MRX-9HTB-4WLN`) that is shown once and stored only as a bcrypt hash.
"Forgot password?" on the login page exchanges that code plus a new password
for access, and issues a fresh code. `/api/login`, `/api/register` and
`/api/recover` are rate-limited per IP.

If both the password and the recovery code are lost, the site owner can reset
any account from a machine that has `server/.env`:

```
cd server
node --env-file=.env admin-reset.mjs --list
node --env-file=.env admin-reset.mjs <username> [newPassword]
```

It prints a new password (random if omitted) and a new recovery code.

## Notes

- All secrets live in `server/.env` (gitignored). `JWT_SECRET` is required —
  the server refuses to start without it. In production, set these as
  environment variables in your hosting provider's dashboard instead.
- Files are scoped to the uploader's organization: members see and download
  all org files, but can only delete their own uploads. Other organizations
  get a 404 for files that aren't theirs.
- Databases created before organizations existed are migrated automatically:
  a "Default Organization" is created and existing users/files are moved into
  it.
- Passwords and recovery codes are hashed with the native `bcrypt` package
  (cost 10), using the async `hash` / `compare` calls so a login never blocks
  other requests. It replaced `bcryptjs`, whose `$2a$` hashes it still accepts,
  so existing accounts keep working.
- Login is limited to 15 attempts per 15 minutes per IP address (successful
  logins included); recovery to 10.
- On Render's free plan the server sleeps after ~15 minutes idle and the next
  request waits for it to start. The AR app calls `GET /api/health` when it
  opens and when its login panel appears, so the server is awake by the time
  the user logs in.
