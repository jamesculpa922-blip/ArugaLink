"use strict";
process.env.TZ = process.env.TZ || "Asia/Manila"; // "today" and weekly caps follow local time

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openDb, withTx, verifyPassword } = require("./db");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const CATEGORIES = ["Medicine", "Grocery"];
const BENEFICIARY_TYPES = ["Senior Citizen", "PWD"];

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function detectBrowser(userAgent = "") {
  const ua = String(userAgent);
  if (/Edg\//i.test(ua)) return "Microsoft Edge";
  if (/OPR\//i.test(ua)) return "Opera";
  if (/Firefox\//i.test(ua)) return "Mozilla Firefox";
  if (/Chrome\//i.test(ua)) return "Google Chrome";
  if (/Safari\//i.test(ua)) return "Apple Safari";
  return "Unknown Browser";
}

function logActivity(db, user, action, description, browser = "Unknown") {
  if (!user) return;
  db.prepare(`
    INSERT INTO activity_logs
    (user_id, username, action, description, browser, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(user.id, user.username, action, description, browser, new Date().toISOString());
}

/* ---------- small helpers ---------- */
const pad = n => String(n).padStart(2, "0");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekStart = iso => addDays(iso, -((new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7)); // Monday
const isIsoDate = s =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const toCents = n => Math.round(n * 100);
const peso = c => c / 100;
const normStore = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const str = (v, max) => String(v ?? "").trim().slice(0, max);

function parseMoney(v, { allowZero }) {
  const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000 || (!allowZero && n === 0)) return null;
  const cents = toCents(n);
  return Math.abs(n * 100 - cents) < 1e-6 ? cents : null; // at most 2 decimal places
}

/* ---------- row -> API shape ---------- */
const beneficiaryOut = r => ({
  id: r.id,
  name: r.name,
  category: r.category,
  contact: r.contact,
  medicineCap: peso(r.medicine_cap_centavos),
  groceryCap: peso(r.grocery_cap_centavos)
});
const purchaseOut = r => ({
  id: r.id,
  receiptNo: r.receipt_no,
  date: r.purchase_date,
  beneficiaryId: r.beneficiary_id,
  beneficiaryName: r.beneficiary_name,
  store: r.store,
  category: r.category,
  amount: peso(r.amount_centavos),
  voucher: r.voucher,
  notes: r.notes,
  reasons: JSON.parse(r.reasons || "[]"),
  status: r.status,
  reviewed: !!r.reviewed,
  faceVerified: !!r.face_verified,
  createdAt: r.created_at
});

function createApp(config) {
  const { db } = openDb(config);

  const PURCHASE_SELECT = `SELECT p.*, b.name AS beneficiary_name
    FROM purchases p JOIN beneficiaries b ON b.id = p.beneficiary_id`;
  const getPurchase = id => db.prepare(`${PURCHASE_SELECT} WHERE p.id = ?`).get(id);
  const getBeneficiary = id => db.prepare("SELECT * FROM beneficiaries WHERE id = ?").get(id);

  /* ---------- auth ---------- */
  const sha = t => crypto.createHash("sha256").update(t).digest("hex");
  const failures = new Map(); // ip -> { count, resetAt }
  const WINDOW_MS = 15 * 60 * 1000, MAX_FAILS = 5;

  function authenticate(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (!m) return null;
    return db.prepare(`SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(m[1]), Date.now()) || null;
  }

  /* ---------- routing ---------- */
  const routes = [];
  const route = (method, pattern, handler, auth = true) =>
    routes.push({
      method, auth, handler,
      re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$")
    });

    // ACTIVITY LOG HISTORY
route("GET", "/api/activity-logs", () => {
    return db.prepare(`
        SELECT
            id,
            username,
            action,
            description,
            browser,
            created_at AS createdAt
        FROM activity_logs
        ORDER BY id DESC
        LIMIT 500
    `).all();
});

  /* Login / session */
  route("POST", "/api/login", ({ req, body }) => {
    const ip = req.socket.remoteAddress || "?";
    const f = failures.get(ip);
    if (f && f.resetAt > Date.now() && f.count >= MAX_FAILS)
      throw new HttpError(429, "Too many failed attempts. Try again in a few minutes.");

    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(str(body.username, 60));
    const ok = verifyPassword(String(body.password ?? ""), user?.password_hash ?? "00:00");
    if (!user || !ok) {
      const cur = f && f.resetAt > Date.now() ? f : { count: 0, resetAt: Date.now() + WINDOW_MS };
      cur.count++;
      failures.set(ip, cur);
      throw new HttpError(401, "Incorrect username or password.");
    }
    failures.delete(ip);
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(sha(token), user.id, Date.now() + config.sessionHours * 3600_000);
    logActivity(db, user, "LOGIN", "Administrator successfully logged in.",
      detectBrowser(req.headers["user-agent"] || ""));
    return { token, username: user.username };
  }, false);

  route("POST", "/api/logout", ({ req }) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (m) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(m[1]));
    return { ok: true };
  }, false);

  route("GET", "/api/me", ({ user }) => ({ username: user.username }));

  /* Beneficiaries */
  function parseBeneficiary(b) {
    const id = str(b.id, 40).toUpperCase();
    const name = str(b.name, 120);
    const category = String(b.category ?? "");
    const medicine = parseMoney(b.medicineCap, { allowZero: true });
    const grocery = parseMoney(b.groceryCap, { allowZero: true });
    if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(id))
      throw new HttpError(422, "Beneficiary ID may only use letters, numbers, dot, dash and underscore.");
    if (!name) throw new HttpError(422, "Full name is required.");
    if (!BENEFICIARY_TYPES.includes(category)) throw new HttpError(422, "Choose a valid category.");
    if (medicine === null || grocery === null) throw new HttpError(422, "Caps must be valid peso amounts (0 or more, max 2 decimals).");
    return { id, name, category, contact: str(b.contact, 30), medicine, grocery };
  }

  route("GET", "/api/beneficiaries", () =>
    db.prepare("SELECT * FROM beneficiaries ORDER BY rowid").all().map(beneficiaryOut));

  route("POST", "/api/beneficiaries", ctx => {
    const r = parseBeneficiary(ctx.body);
    if (getBeneficiary(r.id)) throw new HttpError(409, "Beneficiary ID already exists.");
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO beneficiaries (id, name, category, contact,
      medicine_cap_centavos, grocery_cap_centavos, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(r.id, r.name, r.category, r.contact, r.medicine, r.grocery, now, now);
    ctx.status = 201;
    return beneficiaryOut(getBeneficiary(r.id));
  });

  route("PUT", "/api/beneficiaries/:id", ctx => {
    const oldId = decodeURIComponent(ctx.params.id);
    if (!getBeneficiary(oldId)) throw new HttpError(404, "Beneficiary not found.");
    const r = parseBeneficiary(ctx.body);
    if (r.id !== oldId && getBeneficiary(r.id)) throw new HttpError(409, "Beneficiary ID already exists.");
    // ON UPDATE CASCADE carries an ID change through to existing purchases.
    db.prepare(`UPDATE beneficiaries SET id=?, name=?, category=?, contact=?,
      medicine_cap_centavos=?, grocery_cap_centavos=?, updated_at=? WHERE id=?`)
      .run(r.id, r.name, r.category, r.contact, r.medicine, r.grocery, new Date().toISOString(), oldId);
    return beneficiaryOut(getBeneficiary(r.id));
  });

  route("DELETE", "/api/beneficiaries/:id", ({ params }) => {
    const id = decodeURIComponent(params.id);
    if (!getBeneficiary(id)) throw new HttpError(404, "Beneficiary not found.");
    const n = db.prepare("SELECT COUNT(*) AS n FROM purchases WHERE beneficiary_id = ?").get(id).n;
    if (n > 0) throw new HttpError(409, "This beneficiary has purchase records. Delete those purchase records first.");
    db.prepare("DELETE FROM beneficiaries WHERE id = ?").run(id);
    return { ok: true };
  });

  /* Purchases */
  function parsePurchase(b) {
    const r = {
      beneficiaryId: str(b.beneficiaryId, 40).toUpperCase(),
      store: str(b.store, 120),
      category: String(b.category ?? ""),
      cents: parseMoney(b.amount, { allowZero: false }),
      voucher: str(b.voucher, 60),
      date: String(b.date ?? ""),
      notes: str(b.notes, 300),
      faceVerified: b.faceVerified === true
    };
    
    if (!r.beneficiaryId) throw new HttpError(422, "Select or scan a registered beneficiary QR code.");
    if (!r.faceVerified)
      throw new HttpError(422, "Beneficiary face verification is required. Scan the QR code, start the front camera, and have staff confirm the live face against the official ID/photo.");
    if (!r.store || !CATEGORIES.includes(r.category) || !r.voucher || r.cents === null)
      throw new HttpError(422, "Complete all required fields correctly (amount must be above zero, max 2 decimals).");
    if (!isIsoDate(r.date)) throw new HttpError(422, "Enter a valid transaction date.");
    if (r.date > today()) throw new HttpError(422, "Future transaction dates are not allowed.");
    return r;
  }

  const usedInWeek = (benId, category, date, excludeId) => {
    const start = weekStart(date);
    return db.prepare(`SELECT COALESCE(SUM(amount_centavos),0) AS s FROM purchases
      WHERE beneficiary_id=? AND category=? AND purchase_date>=? AND purchase_date<? AND id<>?`)
      .get(benId, category, start, addDays(start, 7), excludeId).s;
  };

  function savePurchase(r, editId, user) {
    return withTx(db, () => {
      const person = getBeneficiary(r.beneficiaryId);
      if (!person) throw new HttpError(422, "Beneficiary is not registered.");
      const excl = editId ?? 0;

      /* Duplicate checks (same rules as the original prototype) */
      const dupVoucher = db.prepare(
        "SELECT receipt_no FROM purchases WHERE voucher = ? COLLATE NOCASE AND id <> ?").get(r.voucher, excl);
      const sameBenefit = db.prepare(`SELECT receipt_no, store FROM purchases
        WHERE beneficiary_id=? AND purchase_date=? AND category=? AND amount_centavos=? AND id<>?`)
        .all(r.beneficiaryId, r.date, r.category, r.cents, excl);
      const exact = sameBenefit.find(p => normStore(p.store) === normStore(r.store));
      const matched = exact || sameBenefit[0];

      if (dupVoucher || matched) {
        const reason = dupVoucher
          ? `DUPLICATE VOUCHER CODE: ${r.voucher} was already used on receipt ${dupVoucher.receipt_no}.`
          : exact
            ? `DUPLICATE PURCHASE: Same beneficiary, date, store, category, and amount already exist on receipt ${exact.receipt_no}.`
            : `POSSIBLE DUPLICATE: Same beneficiary, date, category, and amount already exist on receipt ${matched.receipt_no}, even though the store differs. Staff review is required.`;
        db.prepare(`INSERT INTO fraud_events (attempted_at, purchase_date, beneficiary_id, beneficiary_name,
          store, category, amount_centavos, voucher, reason) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(new Date().toISOString(), r.date, person.id, person.name, r.store, r.category, r.cents, r.voucher, reason);
        return { blocked: reason }; // committed so the attempt stays on record
      }

      /* Flags: weekly cap and frequency */
      const reasons = [];
      const cap = r.category === "Medicine" ? person.medicine_cap_centavos : person.grocery_cap_centavos;
      if (usedInWeek(r.beneficiaryId, r.category, r.date, excl) + r.cents > cap)
        reasons.push(`Weekly ${r.category.toLowerCase()} cap exceeded`);
      const freq = db.prepare(`SELECT COUNT(*) AS n FROM purchases
        WHERE beneficiary_id=? AND purchase_date>=? AND purchase_date<=? AND id<>?`)
        .get(r.beneficiaryId, addDays(r.date, -6), r.date, excl).n;
      if (freq >= 3) reasons.push("Frequent transactions within seven days");
      const status = reasons.length ? "Flagged" : "Normal";
      const now = new Date().toISOString();

      if (editId) {
        const res = db.prepare(`UPDATE purchases SET beneficiary_id=?, store=?, category=?, amount_centavos=?,
          voucher=?, purchase_date=?, notes=?, status=?, reasons=?, reviewed=0, face_verified=1, updated_at=?
          WHERE id=?`)
          .run(r.beneficiaryId, r.store, r.category, r.cents, r.voucher, r.date, r.notes, status, JSON.stringify(reasons), now, editId);
        if (!res.changes) throw new HttpError(404, "Purchase not found.");
        return { id: editId, created: false };
      }

      const prefix = "ARU-" + today().replaceAll("-", "") + "-";
      const last = db.prepare(`SELECT MAX(CAST(substr(receipt_no, ?) AS INTEGER)) AS n
        FROM purchases WHERE receipt_no LIKE ?`).get(prefix.length + 1, prefix + "%").n || 0;
      const receiptNo = prefix + String(last + 1).padStart(4, "0");
      const res = db.prepare(`INSERT INTO purchases (receipt_no, beneficiary_id, store, category, amount_centavos,
        voucher, purchase_date, notes, status, reasons, reviewed, face_verified, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,0,1,?,?,?)`)
        .run(receiptNo, r.beneficiaryId, r.store, r.category, r.cents, r.voucher, r.date, r.notes,
          status, JSON.stringify(reasons), user.id, now, now);
      return { id: Number(res.lastInsertRowid), created: true };
    });
  }

  function purchaseHandler(editIdFrom) {
    return ctx => {
      const editId = editIdFrom ? Number(ctx.params.id) : null;
      if (editIdFrom && !getPurchase(editId)) throw new HttpError(404, "Purchase not found.");
      const r = parsePurchase(ctx.body);
      let out;
      try {
        out = savePurchase(r, editId, ctx.user);
      } catch (e) {
        if (/UNIQUE constraint failed: .*voucher/i.test(e.message)) // lost a race with another request
          throw new HttpError(409, "DUPLICATE PURCHASE BLOCKED. This voucher code was already used.", { code: "DUPLICATE_BLOCKED" });
        throw e;
      }
      if (out.blocked)
        throw new HttpError(409,
          `DUPLICATE PURCHASE BLOCKED. ${out.blocked} No receipt or purchase record was created. This attempt is now visible in Fraud Monitoring.`,
          { code: "DUPLICATE_BLOCKED", reason: out.blocked });
      ctx.status = out.created ? 201 : 200;
      return purchaseOut(getPurchase(out.id));
    };
  }

  route("GET", "/api/purchases", () =>
    db.prepare(`${PURCHASE_SELECT} ORDER BY p.id DESC`).all().map(purchaseOut)); // newest first
  route("POST", "/api/purchases", purchaseHandler(false));
  route("PUT", "/api/purchases/:id", purchaseHandler(true));

  route("DELETE", "/api/purchases/:id", ({ params }) => {
    const res = db.prepare("DELETE FROM purchases WHERE id = ?").run(Number(params.id));
    if (!res.changes) throw new HttpError(404, "Purchase not found.");
    return { ok: true };
  });

  route("POST", "/api/purchases/:id/review", ({ params }) => {
    const res = db.prepare("UPDATE purchases SET reviewed = 1, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), Number(params.id));
    if (!res.changes) throw new HttpError(404, "Purchase not found.");
    return { ok: true };
  });

  route("GET", "/api/purchases/:id/receipt", ({ params }) => {
    const row = getPurchase(Number(params.id));
    if (!row) throw new HttpError(404, "Purchase not found.");
    const person = getBeneficiary(row.beneficiary_id);
    const cap = row.category === "Medicine" ? person.medicine_cap_centavos : person.grocery_cap_centavos;
    const used = usedInWeek(row.beneficiary_id, row.category, row.purchase_date, 0);
    return { purchase: purchaseOut(row), cap: peso(cap), used: peso(used), remaining: peso(Math.max(0, cap - used)) };
  });

  /* Fraud monitoring: blocked attempts + flagged purchases in one list */
  route("GET", "/api/fraud", () => {
    const attempts = db.prepare("SELECT * FROM fraud_events").all().map(a => ({
      kind: "attempt", id: a.id, attemptedAt: a.attempted_at, date: a.purchase_date,
      beneficiaryId: a.beneficiary_id, name: a.beneficiary_name, store: a.store, category: a.category,
      amount: peso(a.amount_centavos), voucher: a.voucher, reason: a.reason, reviewed: !!a.reviewed
    }));
    const flags = db.prepare(`${PURCHASE_SELECT} WHERE p.status = 'Flagged'`).all().map(p => ({
      kind: "purchase", id: p.id, attemptedAt: p.created_at, date: p.purchase_date,
      beneficiaryId: p.beneficiary_id, name: p.beneficiary_name, store: p.store, category: p.category,
      amount: peso(p.amount_centavos), voucher: p.voucher,
      reason: JSON.parse(p.reasons || "[]").join("; "), reviewed: !!p.reviewed
    }));
    return [...attempts, ...flags].sort((a, b) => String(b.attemptedAt).localeCompare(String(a.attemptedAt)));
  });

  route("POST", "/api/fraud-events/:id/review", ({ params }) => {
    const res = db.prepare("UPDATE fraud_events SET reviewed = 1 WHERE id = ?").run(Number(params.id));
    if (!res.changes) throw new HttpError(404, "Fraud event not found.");
    return { ok: true };
  });

  /* Dashboard & analytics */
  route("GET", "/api/dashboard", () => {
    const one = sql => db.prepare(sql).get();
    return {
      beneficiaryCount: one("SELECT COUNT(*) AS n FROM beneficiaries").n,
      purchaseCount: one("SELECT COUNT(*) AS n FROM purchases").n,
      totalSpending: peso(one("SELECT COALESCE(SUM(amount_centavos),0) AS n FROM purchases").n),
      unreviewedFlags:
        one("SELECT COUNT(*) AS n FROM purchases WHERE status='Flagged' AND reviewed=0").n +
        one("SELECT COUNT(*) AS n FROM fraud_events WHERE reviewed=0").n
    };
  });

  route("GET", "/api/analytics", () => {
    const now = new Date();
    const months = [];
    for (let i = 2; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
    }
    const sum = db.prepare(`SELECT COALESCE(SUM(amount_centavos),0) AS s FROM purchases
      WHERE substr(purchase_date,1,7) = ?`);
    const monthly = months.map(label => ({ label, amount: peso(sum.get(label).s) }));
    const average = monthly.reduce((s, m) => s + m.amount, 0) / 3;
    const total = peso(db.prepare("SELECT COALESCE(SUM(amount_centavos),0) AS s FROM purchases").get().s);
    return { total, monthly, average, forecast: average };
  });

  /* ---------- HTTP plumbing ---------- */
  const MIME = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".json": "application/json",
    ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon"
  };

  function serveStatic(req, res, pathname) {
    const rel = pathname === "/" ? "/index.html" : pathname;
    let file;
    try { file = path.resolve(PUBLIC_DIR, "." + decodeURIComponent(rel)); }
    catch { res.writeHead(400, { "Content-Type": "text/plain" }).end("Bad request"); return; }
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    fs.createReadStream(file).pipe(res);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", c => {
        size += c.length;
        if (size > 100_000) { reject(new HttpError(413, "Request too large.")); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        if (!size) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {});
        } catch { reject(new HttpError(400, "Invalid JSON body.")); }
      });
      req.on("error", reject);
    });
  }

  const sendJson = (res, status, data) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(self)");

    const url = new URL(req.url, "http://localhost");
    try {
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
        return serveStatic(req, res, url.pathname);
      }

      let matched = null;
      let pathKnown = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathKnown = true;
        if (r.method === req.method) { matched = { r, params: m.groups || {} }; break; }
      }
      if (!matched) throw new HttpError(pathKnown ? 405 : 404, pathKnown ? "Method not allowed." : "Not found.");

      const user = authenticate(req);
      if (matched.r.auth && !user) throw new HttpError(401, "Please log in.");

      const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readJson(req) : {};
      const ctx = { req, res, params: matched.params, body, user, status: 200 };
      const data = await matched.r.handler(ctx);
      sendJson(res, ctx.status, data);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...err.extra });
      console.error(err);
      sendJson(res, 500, { error: "Internal server error." });
    }
  });

  server.on("close", () => db.close());
  return { server, db };
}

/* ---------- start ---------- */
if (require.main === module) {
  const config = {
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || "127.0.0.1",
    dbPath: process.env.DB_PATH || path.join(__dirname, "..", "data", "arugalink.db"),
    adminUser: process.env.ADMIN_USER || "admin",
    adminPassword: process.env.ADMIN_PASSWORD || "admin123",
    sessionHours: Number(process.env.SESSION_HOURS) || 8
  };
  const { server, db } = createApp(config);
  server.listen(config.port, config.host, () => {
    console.log(`ArugaLink running at http://${config.host}:${config.port}`);
    console.log(`Database file: ${config.dbPath}`);
    const u = db.prepare("SELECT password_hash FROM users WHERE username = ?").get(config.adminUser);
    if (u && verifyPassword("admin123", u.password_hash))
      console.warn("WARNING: the admin account still uses the default password. Run: node src/set-password.js");
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
module.exports = { createApp };
