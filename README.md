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
| GET    | `/api/me`                 | ✔    | Current user + organization     |
| GET    | `/api/org`                | ✔    | Org name, invite code, members  |
| GET    | `/api/files`              | ✔    | List the org's files            |
| POST   | `/api/files`              | ✔    | Upload one file (`file` field)  |
| GET    | `/api/files/:id/download` | ✔    | Download an org file            |
| DELETE | `/api/files/:id`          | ✔    | Delete own file                 |

`POST /api/register` body: `{ username, password, orgMode: "create" | "join",
orgName?, inviteCode? }`.

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
