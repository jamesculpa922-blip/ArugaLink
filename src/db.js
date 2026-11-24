"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || "").split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/** Opens (and creates, if needed) the database, applies the schema, seeds first-run data. */
function openDb({ dbPath, adminUser, adminPassword }) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));

  const now = new Date().toISOString();
  const firstRun = db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0;
  if (firstRun) {
    db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
      .run(adminUser, hashPassword(adminPassword), now);

    // Starter records from the original prototype (only on a brand-new database).
    const ins = db.prepare(`INSERT INTO beneficiaries
      (id, name, category, contact, medicine_cap_centavos, grocery_cap_centavos, created_at, updated_at)
      VALUES (?, ?, ?, ?, 150000, 250000, ?, ?)`);
    ins.run("ARUGA-001", "Juan Dela Cruz", "Senior Citizen", "09123456789", now, now);
    ins.run("ARUGA-002", "Maria Santos", "PWD", "09987654321", now, now);
  }
  return { db, firstRun };
}

/** Runs fn inside a write transaction (BEGIN IMMEDIATE serialises concurrent writers). */
function withTx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    throw err;
  }
}

module.exports = { openDb, withTx, hashPassword, verifyPassword };
