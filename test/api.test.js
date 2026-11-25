"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/server");

let server, base, token;
const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

async function api(method, path, body, auth = true) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(auth && token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json() };
}
const purchase = (o = {}) => ({
  beneficiaryId: "ARUGA-001", store: "ABC Pharmacy", category: "Medicine", amount: 100,
  voucher: "V-" + Math.random().toString(36).slice(2), date: daysAgo(0), notes: "", faceVerified: true, ...o
});

before(async () => {
  ({ server } = createApp({ dbPath: ":memory:", adminUser: "admin", adminPassword: "admin123", sessionHours: 1 }));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
});
after(() => server.close());

test("auth: rejects anonymous and bad logins, accepts good login", async () => {
  assert.equal((await api("GET", "/api/beneficiaries", null, false)).status, 401);
  assert.equal((await api("POST", "/api/login", { username: "admin", password: "nope" }, false)).status, 401);
  const ok = await api("POST", "/api/login", { username: "admin", password: "admin123" }, false);
  assert.equal(ok.status, 200);
  token = ok.data.token;
  assert.equal((await api("GET", "/api/me")).data.username, "admin");
  const activity = await api("GET", "/api/activity-logs");
  assert.equal(activity.status, 200);
  assert.equal(Array.isArray(activity.data), true);
  assert.ok(activity.data.some(item => item.action === "LOGIN"));
});

test("beneficiaries: seed data, create, duplicate, update, delete", async () => {
  assert.equal((await api("GET", "/api/beneficiaries")).data.length, 2);
  const body = { id: "aruga-003", name: "Pedro Reyes", category: "PWD", contact: "0911", medicineCap: 1000, groceryCap: 2000 };
  const c = await api("POST", "/api/beneficiaries", body);
  assert.equal(c.status, 201);
  assert.equal(c.data.id, "ARUGA-003");
  assert.equal((await api("POST", "/api/beneficiaries", body)).status, 409);
  assert.equal((await api("POST", "/api/beneficiaries", { ...body, id: "X", category: "Other" })).status, 422);
  const u = await api("PUT", "/api/beneficiaries/ARUGA-003", { ...body, name: "Pedro R." });
  assert.equal(u.data.name, "Pedro R.");
  assert.equal((await api("DELETE", "/api/beneficiaries/ARUGA-003")).status, 200);
});

test("purchases: face check required, validation, receipt numbering", async () => {
  assert.equal((await api("POST", "/api/purchases", purchase({ faceVerified: false }))).status, 422);
  assert.equal((await api("POST", "/api/purchases", purchase({ amount: -5 }))).status, 422);
  assert.equal((await api("POST", "/api/purchases", purchase({ date: "2999-01-01" }))).status, 422);
  const a = await api("POST", "/api/purchases", purchase({ amount: 100 }));
  assert.equal(a.status, 201);
  assert.match(a.data.receiptNo, /^ARU-\d{8}-0001$/);
  assert.equal(a.data.status, "Normal");
  const b = await api("POST", "/api/purchases", purchase({ amount: 110.5, store: "Other" }));
  assert.match(b.data.receiptNo, /-0002$/);
  assert.equal(b.data.amount, 110.5);
});

test("duplicates: voucher, exact and same-day repeat are blocked and logged", async () => {
  const first = await api("POST", "/api/purchases", purchase({ amount: 77, voucher: "DUP-1" }));
  assert.equal(first.status, 201);
  const v = await api("POST", "/api/purchases", purchase({ amount: 5, voucher: "dup-1" })); // case-insensitive
  assert.equal(v.status, 409);
  assert.match(v.data.reason, /DUPLICATE VOUCHER CODE/);
  const e = await api("POST", "/api/purchases", purchase({ amount: 77, store: "  abc   PHARMACY " }));
  assert.match(e.data.reason, /DUPLICATE PURCHASE:/);
  const s = await api("POST", "/api/purchases", purchase({ amount: 77, store: "Different Store" }));
  assert.match(s.data.reason, /POSSIBLE DUPLICATE/);
  const fraud = (await api("GET", "/api/fraud")).data.filter(x => x.kind === "attempt");
  assert.equal(fraud.length, 3);
  const purchases = (await api("GET", "/api/purchases")).data;
  assert.equal(purchases.filter(p => p.amount === 77).length, 1); // nothing extra saved
});

test("flags: weekly cap exceeded, then review clears the flag count", async () => {
  const before = (await api("GET", "/api/dashboard")).data.unreviewedFlags;
  const big = await api("POST", "/api/purchases", purchase({ category: "Grocery", amount: 2600, voucher: "BIG-1" }));
  assert.equal(big.status, 201);
  assert.equal(big.data.status, "Flagged");
  assert.ok(big.data.reasons.includes("Weekly grocery cap exceeded"));
  assert.equal((await api("GET", "/api/dashboard")).data.unreviewedFlags, before + 1);
  assert.equal((await api("POST", `/api/purchases/${big.data.id}/review`)).status, 200);
  assert.equal((await api("GET", "/api/dashboard")).data.unreviewedFlags, before);
});

test("frequency flag: 4th transaction within seven days", async () => {
  await api("POST", "/api/beneficiaries", { id: "FREQ-1", name: "Freq Tester", category: "PWD", contact: "", medicineCap: 99999, groceryCap: 99999 });
  const out = [];
  for (let i = 0; i < 4; i++)
    out.push((await api("POST", "/api/purchases", purchase({ beneficiaryId: "FREQ-1", amount: 10 + i, voucher: "F-" + i, date: daysAgo(3 - i) }))).data);
  assert.deepEqual(out.map(p => p.status), ["Normal", "Normal", "Normal", "Flagged"]);
  assert.deepEqual(out[3].reasons, ["Frequent transactions within seven days"]);
});

test("edit/delete purchase, receipt, and beneficiary delete protection", async () => {
  const p = (await api("POST", "/api/purchases", purchase({ amount: 40, voucher: "ED-1" }))).data;
  const edited = await api("PUT", `/api/purchases/${p.id}`, purchase({ amount: 45, voucher: "ED-1" })); // may reuse own voucher
  assert.equal(edited.status, 200);
  assert.equal(edited.data.amount, 45);
  assert.equal(edited.data.receiptNo, p.receiptNo);
  const r = await api("GET", `/api/purchases/${p.id}/receipt`);
  assert.equal(r.data.cap, 1500);
  assert.equal(r.data.remaining, Math.max(0, 1500 - r.data.used));
  assert.equal((await api("DELETE", "/api/beneficiaries/ARUGA-001")).status, 409);
  assert.equal((await api("DELETE", `/api/purchases/${p.id}`)).status, 200);
  assert.equal((await api("GET", `/api/purchases/${p.id}/receipt`)).status, 404);
});

test("renaming a beneficiary ID cascades to purchases; analytics adds up", async () => {
  await api("PUT", "/api/beneficiaries/ARUGA-002", { id: "ARUGA-002B", name: "Maria S.", category: "PWD", contact: "", medicineCap: 1500, groceryCap: 2500 });
  await api("POST", "/api/purchases", purchase({ beneficiaryId: "ARUGA-002B", amount: 12.34, voucher: "REN-1" }));
  await api("PUT", "/api/beneficiaries/ARUGA-002B", { id: "ARUGA-002", name: "Maria S.", category: "PWD", contact: "", medicineCap: 1500, groceryCap: 2500 });
  const p = (await api("GET", "/api/purchases")).data.find(x => x.voucher === "REN-1");
  assert.equal(p.beneficiaryId, "ARUGA-002");
  const a = (await api("GET", "/api/analytics")).data;
  const all = (await api("GET", "/api/purchases")).data.reduce((s, x) => s + x.amount, 0);
  assert.ok(Math.abs(a.total - all) < 0.001);
  assert.equal(a.monthly.length, 3);
});

test("static files served, traversal blocked, logout invalidates token", async () => {
  const html = await fetch(base + "/");
  assert.equal(html.status, 200);
  assert.equal((await fetch(base + "/..%2fpackage.json")).status, 404);
  assert.equal((await api("POST", "/api/logout")).status, 200);
  assert.equal((await api("GET", "/api/me")).status, 401);
});
