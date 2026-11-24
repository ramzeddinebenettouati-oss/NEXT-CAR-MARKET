# Moving NEXT-CAR-MARKET off Replit

Target setup:

| Piece | Before (Replit) | After |
|---|---|---|
| Code & development | Replit workspace + Replit Agent | GitHub + Claude Code |
| Database | Replit Postgres | **Supabase** Postgres |
| Uploaded files (vehicle images, documents) | Replit App Storage | **Supabase Storage** (S3 API) |
| Server (API + website + Socket.io) | Replit Autoscale deployment | **Render** web service (`render.yaml`) |
| Chat attachments / vehicle videos (local disk) | Ephemeral disk | Render persistent disk (`/var/data/uploads`) |
| Login | Replit OIDC + JWT | JWT (email/password, Google, WeChat, phone) — Replit login removed |

Do the steps in order. Keep the Replit app running until step 6 is checked.

---

## 1. Create the Supabase project

1. <https://supabase.com/dashboard> → **New project**. Pick a region (use the same one for Render).
2. **Project → Connect → Session pooler**: copy the URI and append
   `?sslmode=require&uselibpqcompat=true`. This is your new `DATABASE_URL`.
3. **Storage → New bucket** → name `autocango`, **keep it private** (the API
   enforces access itself; the bucket must not be public).
4. **Storage → S3 Connection**: note the endpoint and region, and create an
   access key (`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`).

## 2. Copy the database (run in the Replit Shell)

```bash
pg_dump "$DATABASE_URL" --no-owner --no-privileges --format=custom --file=autocango.dump
```

Then restore into Supabase, from the Replit Shell or your own computer:

```bash
pg_restore --no-owner --no-privileges --dbname="<SUPABASE_DATABASE_URL>" autocango.dump
```

Use the **direct** or **session pooler** connection for the restore, never the
transaction pooler (port 6543). A few `already exists` warnings for
extensions are normal. Check the row counts afterwards:

```bash
psql "<SUPABASE_DATABASE_URL>" -c "select count(*) from users" -c "select count(*) from vehicle_listings"
```

## 3. Copy uploaded files (run in the Replit Shell)

In the Replit Shell, `echo $PRIVATE_OBJECT_DIR` shows the bucket name in its first
segment (e.g. `/replit-objstore-xxxx/.private`).

```bash
mkdir -p /tmp/mig && cp scripts/migrate-from-replit/copy-object-storage.mjs /tmp/mig/
cd /tmp/mig && npm init -y >/dev/null && npm i @google-cloud/storage @aws-sdk/client-s3
export SOURCE_BUCKET=replit-objstore-xxxx TARGET_BUCKET=autocango
export S3_ENDPOINT=https://<ref>.supabase.co/storage/v1/s3 S3_REGION=<region>
export S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...
DRY_RUN=1 node copy-object-storage.mjs   # check the list first
node copy-object-storage.mjs             # then copy (safe to re-run)
```

The script prints the `PRIVATE_OBJECT_DIR` / `PUBLIC_OBJECT_SEARCH_PATHS`
values to use on Render.

Files in `artifacts/api-server/uploads/` (chat attachments, vehicle videos)
lived on Replit's local disk. If you have any you need, download that folder
from the Replit file tree, then upload it to the Render disk in step 4 (Render
→ Shell, or `scp` with Render SSH) into `/var/data/uploads/`.

## 4. Deploy on Render

1. Push this branch to GitHub and merge it.
2. Render → **New → Blueprint** → pick the repository. Render reads `render.yaml`.
3. Fill in the env vars it asks for (`DATABASE_URL`, `S3_*`,
   `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS`, `APP_URL`, and the
   integration keys you used on Replit: copy them from Replit → Secrets).
   `JWT_*` and `SESSION_SECRET` are generated automatically. Existing users
   will simply need to log in again.
4. Wait for the deploy, then open `https://<service>.onrender.com/api/healthz`.
   It should return `{"status":"ok"}`.

## 5. Update external services

- **Google OAuth** (Google Cloud console → Credentials): add
  `https://<your-domain>/api/auth/google/callback` as an authorised redirect URI.
- **WeChat** login: update the callback domain.
- **Resend / SendGrid**: no change, as long as the same keys are set.
- **Custom domain**: Render → Settings → Custom Domains, update DNS, then set
  `APP_URL=https://<your-domain>`.

## 6. Check, then switch off Replit

- Log in as an existing user, open a listing with photos, upload a new photo,
  send a chat message (Socket.io), trigger a password-reset e-mail.
- Once everything works, point DNS at Render and stop the Replit deployment.

## Notes

- `users.replit_sub` and the `sessions` table are left in the schema so the
  data dump restores cleanly. Nothing uses them now, and they can be dropped later.
- On an **empty** database (no `super_admin` user) the server creates one at
  startup from `INITIAL_ADMIN_EMAIL` (default `admin@nextcarmarket.com`) and
  `INITIAL_ADMIN_PASSWORD` (`artifacts/api-server/src/index.ts`). In
  production there is no default password: if `INITIAL_ADMIN_PASSWORD` is
  unset, nothing is created and a warning is logged. Outside production it
  falls back to the dev password `SuperAdmin123!`. After a data migration your
  existing super admin is kept, so this doesn't happen. If you do start fresh,
  set a strong password in Render, log in, change it, then clear the variable.
