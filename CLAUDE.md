# NEXT-CAR-MARKET (AutoCango)

Vehicle marketplace: buyers, sellers, freight forwarders and admins. It covers listings, quotations, orders, payments, shipments, real-time chat, and an internal admin messaging system.

## Run & Operate

- `cp .env.example .env` and fill in `DATABASE_URL` (local Postgres or Supabase)
- `pnpm install`
- `pnpm --filter @workspace/db run push` — push DB schema (dev only)
- `pnpm --filter @workspace/api-server run seed` — demo data (dev only)
- `pnpm --filter @workspace/api-server run dev` — API on `PORT` (default 8080 in `.env.example`)
- `pnpm --filter @workspace/web run dev` — web on :5173, proxies `/api` to `API_PORT` (default 8080)
- `pnpm run typecheck` / `pnpm run build` — whole workspace
- `pnpm --filter @workspace/api-server test` — smoke tests against a running server (`API_BASE_URL`, default http://localhost:8080; run the server with `NODE_ENV=development` or the login rate limiter returns 429)
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + Socket.io (`/api/socket.io`), esbuild bundle → `artifacts/api-server/dist/index.mjs`
- Web: React 19 + Vite + Tailwind + wouter, built to `artifacts/web/dist/public`
- DB: PostgreSQL + Drizzle ORM (`lib/db/src/schema`), plus idempotent DDL in `initDb()` (`artifacts/api-server/src/index.ts`)
- Validation: Zod, `drizzle-zod`; API codegen: Orval

## Hosting

- Render web service defined in `render.yaml`. The API process also serves the built web app with an SPA fallback (`app.ts`).
- Supabase Postgres (`DATABASE_URL` with `?sslmode=require&uselibpqcompat=true`).
- Supabase Storage through its S3 API (`lib/objectStorage.ts`). `PRIVATE_OBJECT_DIR` and `PUBLIC_OBJECT_SEARCH_PATHS` are `/<bucket>/<prefix>`. Object ACLs live in S3 user metadata under `aclpolicy`.
- Multer uploads (chat attachments, vehicle videos) go to `UPLOADS_DIR` (the Render persistent disk).
- Moved off Replit: see `docs/MIGRATION-FROM-REPLIT.md`.

## Gotchas

- `pnpm run build` runs the full typecheck first, so type errors fail the deploy.
- `NODE_ENV=production` requires `JWT_SECRET` and `JWT_REFRESH_SECRET`.
- Web dependencies are devDependencies, so production installs need `--prod=false`.
- `artifacts/mockup-sandbox` is a design-preview sandbox, not deployed.
