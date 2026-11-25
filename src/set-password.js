"use strict";
// Usage: node src/set-password.js <username> <new-password>
const path = require("node:path");
const { openDb, hashPassword } = require("./db");

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 8) {
  console.error("Usage: node src/set-password.js <username> <new-password (8+ characters)>");
  process.exit(1);
}
const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "data", "arugalink.db");
const { db } = openDb({ dbPath, adminUser: username, adminPassword: password });
const res = db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(hashPassword(password), username);
if (res.changes) {
  db.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)").run(username);
  console.log(`Password updated for "${username}". Existing sessions were signed out.`);
} else {
  console.error(`No user named "${username}".`);
  process.exit(1);
}
db.close();
