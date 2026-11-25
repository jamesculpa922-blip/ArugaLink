# ArugaLink — backend + database

Node.js + SQLite backend for the ArugaLink benefit-management front end.
No `npm install` needed: it only uses Node's built-in `http` and `node:sqlite`.

**Requires Node.js 22.13 or newer** (`node -v`). A one-line "SQLite is experimental" warning on start-up is normal.

## Run

```bash
node src/server.js          # or: npm start
```

Open http://127.0.0.1:3000 and log in with **admin / admin123** (first run only).
Change that password right away:

```bash
node src/set-password.js admin "a-new-password"
```

Settings (environment variables): `PORT` (3000), `HOST` (127.0.0.1; use `0.0.0.0` to allow other devices on your network),
`DB_PATH` (data/arugalink.db), `SESSION_HOURS` (8), `ADMIN_USER` / `ADMIN_PASSWORD` (only used to create the first account), `TZ` (Asia/Manila).

Camera access (QR scan / face check) only works on `localhost` or HTTPS.

## Viewing the database in a DB client

The database is one file: `data/arugalink.db` (created on first run, with the tables from `schema.sql`).

- **VS Code "Database Client" extension:** Database panel → **+** → choose **SQLite** → select `data/arugalink.db`.
- **DBeaver / DB Browser for SQLite / TablePlus:** new SQLite connection → same file.

Tables: `users`, `sessions`, `beneficiaries`, `purchases`, `fraud_events`.
Amounts are stored as integer centavos (25075 = ₱250.75). Browse and query freely; for edits to purchases or
beneficiaries prefer the app so the fraud rules run.

## What moved to the server

| Rule | Where it is enforced |
|---|---|
| Login, sessions (8 h), failed-login lockout (5 tries / 15 min), scrypt-hashed passwords | server |
| Unique voucher codes (case-insensitive) | server **and** a DB unique index |
| Duplicate / possible-duplicate blocking, logged to `fraud_events` | server |
| Weekly (Mon–Sun) medicine/grocery caps, ≥3-in-7-days flag | server |
| Receipt numbers `ARU-YYYYMMDD-0001` (race-safe) | server (transaction) |
| Can't delete a beneficiary with purchases; ID rename cascades | DB foreign keys |
| Dashboard totals, monthly analytics | server |

## API (all JSON, `Authorization: Bearer <token>` except login)

| Method | Path |
|---|---|
| POST | `/api/login`, `/api/logout` · GET `/api/me` |
| GET / POST | `/api/beneficiaries` |
| PUT / DELETE | `/api/beneficiaries/:id` |
| GET / POST | `/api/purchases` |
| PUT / DELETE | `/api/purchases/:id` |
| POST | `/api/purchases/:id/review` |
| GET | `/api/purchases/:id/receipt` |
| GET | `/api/fraud` · POST `/api/fraud-events/:id/review` |
| GET | `/api/dashboard`, `/api/analytics` |

Duplicate purchases return **409** with `{ "code": "DUPLICATE_BLOCKED", "reason": "..." }`.

## Tests

```bash
npm test
```

## Notes / limits

- The face check is still **staff attestation** (a tick-box after looking at the camera), exactly as in the prototype. The server requires the flag and stores it, but it is not automated face recognition.
- Data saved in the old prototype's browser `localStorage` is not migrated; the database starts with the two sample beneficiaries.
- This is a prototype-grade setup: one admin role, no HTTPS. Put it behind HTTPS (e.g. a reverse proxy) before exposing it beyond your own machine.
- Want MySQL/PostgreSQL instead? `schema.sql` ports with small changes (`AUTOINCREMENT` → `AUTO_INCREMENT`/`SERIAL`, drop `COLLATE NOCASE` on the voucher index); the routes would need a driver swap in `src/db.js`/`src/server.js`.
