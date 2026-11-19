<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/29686785-c69a-4f4e-999d-8d2448ea50d9

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
 3. Run the app:
    `npm run dev`

## PostgreSQL setup

SmartAttend uses PostgreSQL. Copy `.env.example` to `.env` and set `DATABASE_URL` to your
PostgreSQL connection string. The schema and seed accounts are created automatically on first
start.

Seed logins include `superadmin` / `Admin@123`, `admin_abc` / `Password@123`, `rahul` /
`Password@123`, and `neha_temp` / `Temp@123` (forced password change on first login).

To copy data from an existing local SQLite database:

```
DATABASE_URL="postgres://..." SQLITE_DB_PATH="./smartattend.db" npm run migrate:sqlite
```

The migration is idempotent: it preserves existing IDs and password hashes and never overwrites
rows that already exist in PostgreSQL.

## Deploy to Render

The root `render.yaml` defines a Node web service and a managed PostgreSQL database. Render
injects `DATABASE_URL`, `PORT`, and `NODE_ENV=production` automatically. Build and start are:

```
npm ci && npm run build
npm start
```

In production the Express server serves the built frontend from `dist` and exposes
`GET /api/health`. Database credentials are only read by the backend through `DATABASE_URL`;
no database configuration is exposed to Vite or frontend code.
