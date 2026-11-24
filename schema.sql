-- ArugaLink database schema (SQLite).
-- Money is stored as integer centavos to avoid floating-point rounding errors.
-- Dates are ISO text (YYYY-MM-DD); timestamps are ISO-8601 UTC text.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,                       -- "salt:hash" (scrypt, hex)
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                       -- sha256 of the bearer token
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL                        -- unix ms
);

CREATE TABLE IF NOT EXISTS beneficiaries (
  id                    TEXT PRIMARY KEY,            -- Beneficiary ID / QR ID, e.g. ARUGA-001
  name                  TEXT NOT NULL,
  category              TEXT NOT NULL CHECK (category IN ('Senior Citizen','PWD')),
  contact               TEXT NOT NULL DEFAULT '',
  medicine_cap_centavos INTEGER NOT NULL CHECK (medicine_cap_centavos >= 0),
  grocery_cap_centavos  INTEGER NOT NULL CHECK (grocery_cap_centavos >= 0),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no      TEXT NOT NULL UNIQUE,              -- ARU-YYYYMMDD-0001
  beneficiary_id  TEXT NOT NULL REFERENCES beneficiaries(id)
                    ON UPDATE CASCADE ON DELETE RESTRICT,
  store           TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN ('Medicine','Grocery')),
  amount_centavos INTEGER NOT NULL CHECK (amount_centavos > 0),
  voucher         TEXT NOT NULL,
  purchase_date   TEXT NOT NULL,
  notes           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'Normal' CHECK (status IN ('Normal','Flagged')),
  reasons         TEXT NOT NULL DEFAULT '[]',        -- JSON array of flag reasons
  reviewed        INTEGER NOT NULL DEFAULT 0,
  face_verified   INTEGER NOT NULL DEFAULT 0,        -- staff attested a visual face check
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- A voucher can only ever be used once (case-insensitive); enforced by the DB itself.
CREATE UNIQUE INDEX IF NOT EXISTS ux_purchases_voucher ON purchases(voucher COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS ix_purchases_benef_date ON purchases(beneficiary_id, purchase_date);
CREATE INDEX IF NOT EXISTS ix_purchases_date ON purchases(purchase_date);

-- Blocked duplicate attempts (not saved as purchases). Values are snapshots.
CREATE TABLE IF NOT EXISTS fraud_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  attempted_at     TEXT NOT NULL,
  purchase_date    TEXT,
  beneficiary_id   TEXT,
  beneficiary_name TEXT,
  store            TEXT,
  category         TEXT,
  amount_centavos  INTEGER,
  voucher          TEXT,
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'Blocked duplicate',
  reviewed         INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    description TEXT,
    browser TEXT DEFAULT 'Unknown',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS
idx_activity_created_at
ON activity_logs(created_at);