
"use strict";

const $ = id => document.getElementById(id);

const money = n => Number(n || 0).toLocaleString("en-PH", {
  style: "currency",
  currency: "PHP"
});

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[c]));

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};

/* STATE (loaded from the backend API) */
let beneficiaries = [];
let purchases = [];      // newest first
let fraudEvents = [];    // blocked attempts + flagged purchases, newest first
let dashboard = { beneficiaryCount: 0, purchaseCount: 0, totalSpending: 0, unreviewedFlags: 0 };
let analytics = { total: 0, monthly: [], average: 0, forecast: 0 };
let activityLogs = [];
let beneficiaryIdVerified = false;
let beneficiaryIdPreviewURL = "";
let qrScanner = null;
let faceStream = null;
let faceVerifiedBeneficiaryId = "";

/* API CLIENT */
const TOKEN_KEY = "arugaToken";

async function api(method, url, body) {
  const headers = {};
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw Object.assign(new Error("Cannot reach the server. Is it running?"), { network: true });
  }

  let data = {};
  try { data = await res.json(); } catch {}

  if (res.status === 401 && url !== "/api/login") {
    signOut("Your session expired. Please log in again.");
  }

  if (!res.ok) {
    throw Object.assign(new Error(data.error || "Request failed (" + res.status + ")"), {
      status: res.status,
      data
    });
  }

  return data;
}

async function loadAll() {
  try {
    const [b, p, f, d, a] = await Promise.all([
      api("GET", "/api/beneficiaries"),
      api("GET", "/api/purchases"),
      api("GET", "/api/fraud"),
      api("GET", "/api/dashboard"),
      api("GET", "/api/analytics")
    ]);
    beneficiaries = b; purchases = p; fraudEvents = f; dashboard = d; analytics = a;
    try {
    activityLogs = await api("GET", "/api/activity-logs");
    if (!Array.isArray(activityLogs)) activityLogs = [];
} catch (err) {
    activityLogs = [];
    console.error("Activity logs error:", err);
}
    renderAll();
  } catch (err) {
    if (err.status !== 401) console.error(err);
  }
}

/* LOGIN */
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();

  try {
    const r = await api("POST", "/api/login", {
      username: $("username").value.trim(),
      password: $("password").value
    });
    sessionStorage.setItem(TOKEN_KEY, r.token);
    $("loginError").textContent = "";
    showApp();
  } catch (err) {
    $("loginError").textContent = err.message;
  }
});

function showApp() {
  $("loginScreen").classList.add("hidden");
  $("appScreen").classList.remove("hidden");
  $("purchaseDate").value = today();
  loadAll();
}

function signOut(message = "") {
  sessionStorage.removeItem(TOKEN_KEY);
  stopQrScanner();
  stopFaceCamera();
  $("appScreen").classList.add("hidden");
  $("loginScreen").classList.remove("hidden");
  $("loginForm").reset();
  $("loginError").textContent = message;
}

$("logoutBtn").addEventListener("click", async () => {
  try { await api("POST", "/api/logout"); } catch {}
  signOut();
});

/* NAVIGATION */
document.querySelectorAll(".nav-btn").forEach(b => {
  b.addEventListener("click", () => openPage(b.dataset.page));
});

function openPage(name) {
  document.querySelectorAll(".page").forEach(p =>
    p.classList.add("hidden")
  );

  $(name).classList.remove("hidden");

  document.querySelectorAll(".nav-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.page === name)
  );

  $("pageTitle").textContent = ({
    dashboard: "Dashboard",
    beneficiaries: "Beneficiary Management",
    purchases: "Purchase Logging",
    fraud: "Fraud Monitoring",
    analytics: "Budget Analytics",
    activity: "Activity Logs"
  })[name];

  if (name !== "purchases") {
    stopQrScanner();
    stopFaceCamera();
  }

  loadAll();
}

/* BENEFICIARY CRUD */
$("beneficiaryForm").addEventListener("submit", async e => {
  e.preventDefault();

  const oldId = $("beneficiaryEditId").value;
  const msg = $("beneficiaryMessage");

  const r = {
    id: $("beneficiaryId").value.trim().toUpperCase(),
    name: $("beneficiaryName").value.trim(),
    category: $("beneficiaryCategory").value,
    contact: $("beneficiaryContact").value.trim(),
    medicineCap: Number($("medicineCap").value),
    groceryCap: Number($("groceryCap").value)
  };

  if (!r.id || !r.name || !r.category ||
      !(r.medicineCap >= 0) || !(r.groceryCap >= 0)) {
    msg.textContent = "Please enter valid information.";
    return;
  }

  try {
    if (oldId) await api("PUT", "/api/beneficiaries/" + encodeURIComponent(oldId), r);
    else await api("POST", "/api/beneficiaries", r);

    resetBeneficiary();
    msg.textContent = oldId ? "Beneficiary updated." : "Beneficiary added.";
    await loadAll();
  } catch (err) {
    msg.textContent = err.message;
  }
});

function resetBeneficiary() {
  $("beneficiaryForm").reset();
  $("beneficiaryEditId").value = "";
  $("medicineCap").value = 1500;
  $("groceryCap").value = 2500;
  $("beneficiaryFormTitle").textContent = "Register Beneficiary";
  $("beneficiarySaveBtn").textContent = "Add Beneficiary";
  $("cancelBeneficiaryEdit").classList.add("hidden");
}

$("cancelBeneficiaryEdit").addEventListener("click", resetBeneficiary);

function renderBeneficiaries() {
  const q = $("beneficiaryFilter").value.toLowerCase();

  const list = beneficiaries.filter(p =>
    (p.id + " " + p.name).toLowerCase().includes(q)
  );

  $("beneficiaryTable").innerHTML = list.map(p => `
    <tr>
      <td>${esc(p.id)}</td>
      <td>${esc(p.name)}</td>
      <td>${esc(p.category)}</td>
      <td>${esc(p.contact)}</td>
      <td>${money(p.medicineCap)}</td>
      <td>${money(p.groceryCap)}</td>
      <td>
        <button class="action-btn review-btn"
          data-action="show-qr" data-id="${esc(p.id)}">QR Code</button>
        <button class="action-btn edit-btn"
          data-action="edit-person" data-id="${esc(p.id)}">Edit</button>
        <button class="action-btn delete-btn"
          data-action="delete-person" data-id="${esc(p.id)}">Delete</button>
      </td>
    </tr>
  `).join("") || '<tr><td colspan="7">No beneficiaries found.</td></tr>';

  const select = $("purchaseBeneficiary");
  const current = select.value;

  select.innerHTML =
    '<option value="">Select beneficiary</option>' +
    beneficiaries.map(p =>
      `<option value="${esc(p.id)}">${esc(p.id)} - ${esc(p.name)}</option>`
    ).join("");

  if (beneficiaries.some(p => p.id === current)) {
    select.value = current;
  }
}

function editPerson(id) {
  const p = beneficiaries.find(x => x.id === id);
  if (!p) return;

  $("beneficiaryEditId").value = p.id;
  $("beneficiaryId").value = p.id;
  $("beneficiaryName").value = p.name;
  $("beneficiaryCategory").value = p.category;
  $("beneficiaryContact").value = p.contact;
  $("medicineCap").value = p.medicineCap;
  $("groceryCap").value = p.groceryCap;

  $("beneficiaryFormTitle").textContent = "Update Beneficiary";
  $("beneficiarySaveBtn").textContent = "Save Changes";
  $("cancelBeneficiaryEdit").classList.remove("hidden");
  $("beneficiaryForm").scrollIntoView({ behavior: "smooth" });
}

async function deletePerson(id) {
  if (purchases.some(p => p.beneficiaryId === id)) {
    alert("This beneficiary has purchase records. Delete those purchase records first.");
    return;
  }

  if (!confirm("Delete beneficiary " + id + "?")) return;

  try {
    await api("DELETE", "/api/beneficiaries/" + encodeURIComponent(id));
    await loadAll();
  } catch (err) {
    alert(err.message);
  }
}

/* QR SCANNER */
function resetFaceVerification(message =
  "Face verification is required before saving a purchase.") {
  faceVerifiedBeneficiaryId = "";
  $("faceConfirmed").checked = false;
  $("faceConfirmed").disabled = true;
  $("faceMessage").textContent = message;
  $("faceMessage").className = "hint";
}

$("purchaseBeneficiary").addEventListener("change", () =>
  resetFaceVerification("Beneficiary changed. Start a new face check.")
);

$("startQrBtn").addEventListener("click", async () => {
  if (!window.Html5Qrcode) {
    $("qrMessage").textContent =
      "QR scanner library did not load. Check your internet connection.";
    return;
  }

  if (qrScanner) {
    await stopQrScanner();
    return;
  }

  $("qrReader").classList.remove("hidden");
  $("qrMessage").textContent =
    "Allow camera access, then point the camera at the beneficiary QR code.";

  qrScanner = new Html5Qrcode("qrReader");

  try {
    await qrScanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 230, height: 230 } },
      async decodedText => {
        let scanned = decodedText.trim();

        try {
          const obj = JSON.parse(scanned);
          scanned = obj.beneficiaryId || obj.id || scanned;
        } catch {}

        const person = beneficiaries.find(p =>
          p.id.toLowerCase() === String(scanned).trim().toLowerCase()
        );

        if (person) {
          $("purchaseBeneficiary").value = person.id;

          resetFaceVerification(
            "QR accepted for " + person.name +
            ". Now complete the live face check."
          );

          $("qrMessage").textContent =
            "QR accepted: " + person.name + " (" + person.id + ").";

          $("qrMessage").className = "success-message";
          await stopQrScanner();
        } else {
          $("qrMessage").textContent =
            "QR code not recognized. This is not a registered beneficiary ID.";

          $("qrMessage").className = "error-message";
        }
      },
      () => {}
    );
  } catch (err) {
    qrScanner = null;
    $("qrReader").classList.add("hidden");
    $("qrMessage").textContent =
      "Camera could not start. Use localhost or HTTPS and allow camera permission.";
    $("qrMessage").className = "error-message";
  }
});

async function stopQrScanner() {
  if (qrScanner) {
    try {
      if (qrScanner.isScanning) await qrScanner.stop();
      await qrScanner.clear();
    } catch {}

    qrScanner = null;
  }

  if ($("qrReader")) $("qrReader").classList.add("hidden");
}

/* STAFF-ASSISTED FACE CHECK
   This is not automated facial recognition. */
$("startFaceBtn").addEventListener("click", async () => {
  const person = beneficiaries.find(
    p => p.id === $("purchaseBeneficiary").value
  );
if (!beneficiaryIdVerified) {
    $("faceMessage").textContent =
        "Please upload and review the beneficiary ID first.";

    $("faceMessage").className = "error-message";
    return;
}
  if (!person) {
    $("faceMessage").textContent =
      "Select a beneficiary or scan their QR code first.";
    $("faceMessage").className = "error-message";
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    $("faceMessage").textContent =
      "Camera unavailable. Open through localhost or HTTPS.";
    $("faceMessage").className = "error-message";
    return;
  }

  try {
    await stopFaceCamera();

    faceStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false
    });

    $("faceVideo").srcObject = faceStream;
    $("faceVideo").classList.remove("hidden");
    $("faceConfirmed").disabled = false;
    $("faceConfirmed").checked = false;
    faceVerifiedBeneficiaryId = "";

    $("faceMessage").textContent =
      "Camera active. Staff: compare the live person with the official ID/photo, then tick the confirmation.";

    $("faceMessage").className = "hint";
  } catch (err) {
    $("faceMessage").textContent =
      "Unable to open the front camera. Allow camera permission and use localhost or HTTPS.";

    $("faceMessage").className = "error-message";
  }
});

$("faceConfirmed").addEventListener("change", () => {
  const id = $("purchaseBeneficiary").value;

  if ($("faceConfirmed").checked && faceStream && id) {
    faceVerifiedBeneficiaryId = id;

    $("faceMessage").textContent =
      "Face check confirmed by staff for " + id + ". You may continue.";

    $("faceMessage").className = "success-message";
  } else {
    faceVerifiedBeneficiaryId = "";
    $("faceMessage").textContent = "Face check is not confirmed.";
    $("faceMessage").className = "error-message";
  }
});

async function stopFaceCamera() {
  if (faceStream) {
    faceStream.getTracks().forEach(track => track.stop());
    faceStream = null;
  }

  if ($("faceVideo")) {
    $("faceVideo").srcObject = null;
    $("faceVideo").classList.add("hidden");
  }

  faceVerifiedBeneficiaryId = "";

  if ($("faceConfirmed")) {
    $("faceConfirmed").checked = false;
    $("faceConfirmed").disabled = true;
  }
}

/* PURCHASE CREATE / UPDATE
   Quick checks run here for instant feedback; the server repeats every check and
   is the authority for duplicate blocking, weekly caps and fraud flags. */
$("purchaseForm").addEventListener("submit", async e => {
  e.preventDefault();

  const editId = $("purchaseEditId").value;

  const person = beneficiaries.find(
    p => p.id === $("purchaseBeneficiary").value
  );

  const r = {
    beneficiaryId: person?.id || "",
    store: $("partnerStore").value.trim(),
    category: $("purchaseCategory").value,
    amount: Number($("purchaseAmount").value),
    voucher: $("voucherCode").value.trim(),
    date: $("purchaseDate").value,
    notes: $("purchaseNotes").value.trim()
  };

  const msg = $("purchaseMessage");
  msg.className = "message";

  const fail = text => {
    msg.textContent = text;
    msg.classList.add("error-message");
  };

  if (!person) return fail("Select or scan a registered beneficiary QR code.");

  if (faceVerifiedBeneficiaryId !== person.id) {
    return fail("ERROR — Beneficiary face verification is required. Scan the QR code, start the front camera, and have staff confirm the live face against the official ID/photo.");
  }

  if (!r.store || !r.category || !r.voucher || !r.date ||
      !Number.isFinite(r.amount) || r.amount <= 0) {
    return fail("Complete all required fields correctly.");
  }

  if (r.date > today()) return fail("Future transaction dates are not allowed.");

  try {
    const saved = await api(
      editId ? "PUT" : "POST",
      editId ? "/api/purchases/" + encodeURIComponent(editId) : "/api/purchases",
      { ...r, faceVerified: true }
    );

    msg.textContent = editId
      ? "Purchase updated. Print the revised receipt if needed."
      : "Purchase saved. Receipt generated successfully.";

    resetPurchase();
    await loadAll();
    showReceipt(saved.id);
  } catch (err) {
    fail("ERROR — " + err.message);

    if (err.data?.code === "DUPLICATE_BLOCKED") {
      openPage("fraud");
    }
  }
});

function resetPurchase() {
  stopFaceCamera();
  faceVerifiedBeneficiaryId = "";
  $("purchaseForm").reset();
  $("faceConfirmed").checked = false;
  $("faceConfirmed").disabled = true;
  $("faceMessage").textContent =
    "Face verification is required before saving a purchase.";
  $("faceMessage").className = "hint";
  $("purchaseEditId").value = "";
  $("purchaseDate").value = today();
  $("purchaseFormTitle").textContent = "Record New Purchase";
  $("purchaseSaveBtn").textContent = "Record Purchase & Create Receipt";
  $("cancelPurchaseEdit").classList.add("hidden");
}

$("cancelPurchaseEdit").addEventListener("click", resetPurchase);

function editPurchase(id) {
  const p = purchases.find(x => String(x.id) === String(id));
  if (!p) return;

  resetFaceVerification("Edit mode: complete a fresh face check before saving.");

  $("purchaseEditId").value = p.id;
  $("purchaseBeneficiary").value = p.beneficiaryId;
  $("partnerStore").value = p.store;
  $("purchaseCategory").value = p.category;
  $("purchaseAmount").value = p.amount;
  $("voucherCode").value = p.voucher;
  $("purchaseDate").value = p.date;
  $("purchaseNotes").value = p.notes || "";

  $("purchaseFormTitle").textContent = "Update Purchase";
  $("purchaseSaveBtn").textContent = "Save Changes";
  $("cancelPurchaseEdit").classList.remove("hidden");
  $("purchaseForm").scrollIntoView({ behavior: "smooth" });
}

async function deletePurchase(id) {
  if (!confirm("Delete this purchase record? Its amount will be removed from recorded spending totals.")) return;

  try {
    await api("DELETE", "/api/purchases/" + encodeURIComponent(id));
    await loadAll();
  } catch (err) {
    alert(err.message);
  }
}

/* RECEIPT PREVIEW */
async function showReceipt(id) {
  let r;

  try {
    r = await api("GET", "/api/purchases/" + encodeURIComponent(id) + "/receipt");
  } catch (err) {
    alert(err.message);
    return;
  }

  const p = r.purchase;
  const cap = r.cap;
  const remaining = r.remaining;

  $("receiptContent").innerHTML = `
    <div class="receipt-line"><span>Receipt No.</span><strong>${esc(p.receiptNo)}</strong></div>
    <div class="receipt-line"><span>Transaction Date</span><strong>${esc(p.date)}</strong></div>
    <div class="receipt-line"><span>Beneficiary ID</span><strong>${esc(p.beneficiaryId)}</strong></div>
    <div class="receipt-line"><span>Beneficiary Name</span><strong>${esc(p.beneficiaryName)}</strong></div>
    <div class="receipt-line"><span>Category</span><strong>${esc(p.category)}</strong></div>
    <div class="receipt-line"><span>Partner Store</span><strong>${esc(p.store)}</strong></div>
    <div class="receipt-line"><span>Items / Details</span><strong>${esc(p.notes || "Not specified")}</strong></div>
    <div class="receipt-line"><span>Voucher Code</span><strong>${esc(p.voucher)}</strong></div>
    <div class="receipt-line receipt-total"><span>Recorded Amount</span><strong>${money(p.amount)}</strong></div>
    <div class="receipt-line"><span>Weekly ${esc(p.category)} Cap</span><strong>${money(cap)}</strong></div>
    <div class="receipt-line"><span>Remaining after this record</span><strong>${money(remaining)}</strong></div>
    <div class="receipt-line"><span>Transaction Status</span><strong>${esc(p.status === "Flagged" ? "For staff review" : "Recorded")}</strong></div>
    <p class="hint">Calculated from all saved purchases in the same Monday–Sunday week. A flagged record is not proof of fraud.</p>
  `;

  $("receiptModal").classList.remove("hidden");
}

$("printReceiptBtn").addEventListener("click", () => window.print());

$("closeReceiptBtn").addEventListener("click", () =>
  $("receiptModal").classList.add("hidden")
);

$("receiptModal").addEventListener("click", e => {
  if (e.target === $("receiptModal")) {
    $("receiptModal").classList.add("hidden");
  }
});

function badge(p) {
  return p.status === "Flagged" && !p.reviewed
    ? '<span class="status flagged">Flagged</span>'
    : p.status === "Flagged"
      ? '<span class="status reviewed">Reviewed</span>'
      : '<span class="status safe">Normal</span>';
}

/* PURCHASE HISTORY */
function renderPurchases() {
  const q = $("purchaseFilter").value.toLowerCase();

  const list = purchases.filter(p =>
    (p.receiptNo + " " + p.beneficiaryName + " " +
      p.beneficiaryId + " " + p.voucher).toLowerCase().includes(q)
  );

  $("purchaseTable").innerHTML = list.map(p => `
    <tr>
      <td>${esc(p.receiptNo)}</td>
      <td>${esc(p.date)}</td>
      <td>${esc(p.beneficiaryName)}</td>
      <td>${esc(p.store)}</td>
      <td>${esc(p.category)}</td>
      <td>${money(p.amount)}</td>
      <td>${esc(p.voucher)}</td>
      <td>${badge(p)}</td>
      <td>
        <button class="action-btn review-btn" data-action="receipt" data-id="${esc(p.id)}">Receipt</button>
        <button class="action-btn edit-btn" data-action="edit-purchase" data-id="${esc(p.id)}">Edit</button>
        <button class="action-btn delete-btn" data-action="delete-purchase" data-id="${esc(p.id)}">Delete</button>
      </td>
    </tr>
  `).join("") || '<tr><td colspan="9">No purchase records found.</td></tr>';

  $("recentTable").innerHTML = purchases.slice(0, 5).map(p => `
    <tr>
      <td>${esc(p.receiptNo)}</td>
      <td>${esc(p.date)}</td>
      <td>${esc(p.beneficiaryName)}</td>
      <td>${esc(p.store)}</td>
      <td>${money(p.amount)}</td>
      <td>${badge(p)}</td>
      <td><button class="action-btn review-btn" data-action="receipt" data-id="${esc(p.id)}">View</button></td>
    </tr>
  `).join("") || '<tr><td colspan="7">No purchase records yet.</td></tr>';
}

/* FRAUD MONITORING (rows are merged and sorted by the server) */
function renderFraud() {
  const rows = fraudEvents;

  $("fraudTable").innerHTML = rows.map(x => `
    <tr>
      <td>${esc(x.attemptedAt ? new Date(x.attemptedAt).toLocaleString() : x.date)}</td>
      <td><b>${esc(x.beneficiaryId || "—")}</b><br>${esc(x.name || "Unknown")}</td>
      <td>${esc(x.store || "—")}</td>
      <td>${esc(x.category || "—")}</td>
      <td>${money(x.amount)}</td>
      <td>${esc(x.voucher || "—")}</td>
      <td class="fraud-reason">${esc(x.reason || "Review needed")}</td>
      <td>
        <span class="status ${x.kind === "attempt" ? "blocked" : (x.reviewed ? "reviewed" : "flagged")}">
          ${x.kind === "attempt" ? "BLOCKED" : (x.reviewed ? "Reviewed" : "Flagged")}
        </span>
      </td>
      <td>
        ${x.reviewed ? "—" : `<button class="action-btn review-btn" data-action="review-${x.kind}" data-id="${esc(x.id)}">Mark Reviewed</button>`}
      </td>
    </tr>
  `).join("") || '<tr><td colspan="9">No duplicate attempts or flagged transactions.</td></tr>';
}

/* DASHBOARD */
function renderDashboard() {
  $("beneficiaryCount").textContent = dashboard.beneficiaryCount;
  $("purchaseCount").textContent = dashboard.purchaseCount;
  $("totalSpending").textContent = money(dashboard.totalSpending);
  $("flagCount").textContent = dashboard.unreviewedFlags;
}

/* BUDGET ANALYTICS */
function renderAnalytics() {
  $("analyticsTotal").textContent = money(analytics.total);
  $("monthlyAverage").textContent = money(analytics.average);
  $("forecastAmount").textContent = money(analytics.forecast);

  const chart = [...analytics.monthly, { label: "Estimate", amount: analytics.forecast }];
  const max = Math.max(1, ...chart.map(x => x.amount));

  $("forecastBars").innerHTML = chart.map(x => `
    <div class="forecast-item">
      <b>${money(x.amount)}</b>
      <div class="forecast-bar" style="height:${Math.max(8, x.amount/max*110)}px"></div>
      ${esc(x.label)}
    </div>
  `).join("");
}

/* BUTTON ACTIONS */
async function reviewItem(url) {
  try {
    await api("POST", url);
    await loadAll();
  } catch (err) {
    alert(err.message);
  }
}

document.addEventListener("click", e => {
  const b = e.target.closest("[data-action]");
  if (!b) return;

  const id = b.dataset.id;

  switch (b.dataset.action) {
    case "show-qr":
      showBeneficiaryQr(id);
      break;

    case "edit-person":
      editPerson(id);
      break;

    case "delete-person":
      deletePerson(id);
      break;

    case "edit-purchase":
      editPurchase(id);
      break;

    case "delete-purchase":
      deletePurchase(id);
      break;

    case "receipt":
      showReceipt(id);
      break;

    case "review-purchase":
      reviewItem("/api/purchases/" + encodeURIComponent(id) + "/review");
      break;

    case "review-attempt":
      reviewItem("/api/fraud-events/" + encodeURIComponent(id) + "/review");
      break;
  }
});

/* SEARCH */
$("beneficiaryFilter").addEventListener("input", renderBeneficiaries);
$("purchaseFilter").addEventListener("input", renderPurchases);

/* GENERATE BENEFICIARY QR CODE */
function showBeneficiaryQr(id) {
  const person = beneficiaries.find(p => p.id === id);
  if (!person) return;

  if (!window.QRCode) {
    alert("QR generator library did not load. Check your internet connection and reload.");
    return;
  }

  $("beneficiaryQrName").textContent = person.name + " — " + person.id;
  $("beneficiaryQrCanvas").innerHTML = "";

  new QRCode($("beneficiaryQrCanvas"), {
    text: person.id,
    width: 220,
    height: 220,
    correctLevel: QRCode.CorrectLevel.M
  });

  $("beneficiaryQrModal").classList.remove("hidden");
}

$("closeBeneficiaryQrBtn").addEventListener("click", () =>
  $("beneficiaryQrModal").classList.add("hidden")
);

$("printBeneficiaryQrBtn").addEventListener("click", () =>
  window.print()
);

/* REFRESH ALL */
function renderAll() {
    renderDashboard();
    renderBeneficiaries();
    renderPurchases();
    renderFraud();
    renderAnalytics();
    renderActivityLogs();
}

/* RESTORE LOGIN SESSION (an expired token sends the user back to the login screen) */
if (sessionStorage.getItem(TOKEN_KEY)) {
  showApp();
} else {
  $("loginScreen").classList.remove("hidden");
  $("appScreen").classList.add("hidden");
}
/* BENEFICIARY ID UPLOAD AND VERIFICATION */

$("verifyIdBtn").addEventListener("click", () => {
    const file = $("beneficiaryIdFile").files[0];
    const message = $("idUploadMessage");

    if (!file) {
        message.textContent = "Please upload an official beneficiary ID first.";
        message.className = "error-message";
        return;
    }

    if (!file.type.startsWith("image/")) {
        message.textContent = "Please upload a valid image file.";
        message.className = "error-message";
        return;
    }

    if (file.size > 5 * 1024 * 1024) {
        message.textContent = "File size must not exceed 5 MB.";
        message.className = "error-message";
        return;
    }

    if (beneficiaryIdPreviewURL) {
        URL.revokeObjectURL(beneficiaryIdPreviewURL);
    }

    beneficiaryIdPreviewURL = URL.createObjectURL(file);

    $("beneficiaryIdPreview").src = beneficiaryIdPreviewURL;

    $("idPreviewContainer").classList.remove("hidden");

    beneficiaryIdVerified = true;

    message.textContent =
        "ID uploaded successfully. Staff must inspect the ID before confirming the beneficiary.";

    message.className = "success-message";
});
function resetBeneficiaryIdUpload() {
    beneficiaryIdVerified = false;

    if (beneficiaryIdPreviewURL) {
        URL.revokeObjectURL(beneficiaryIdPreviewURL);
        beneficiaryIdPreviewURL = "";
    }

    $("beneficiaryIdFile").value = "";
    $("beneficiaryIdPreview").removeAttribute("src");
    $("idPreviewContainer").classList.add("hidden");

    $("idUploadMessage").textContent =
        "Upload the beneficiary's official ID.";

    $("idUploadMessage").className = "hint";
}

$("purchaseBeneficiary").addEventListener("change", () => {
    resetBeneficiaryIdUpload();
});
resetBeneficiaryIdUpload();
function renderActivityLogs() {
    const table = $("activityTable");

    if (!table) return;

    if (!activityLogs.length) {
        table.innerHTML = `
            <tr>
                <td colspan="5">
                    No activity records found.
                </td>
            </tr>
        `;
        return;
    }

    table.innerHTML = activityLogs.map(item => {
        const dateTime = item.createdAt
            ? new Date(item.createdAt).toLocaleString("en-PH", {
                timeZone: "Asia/Manila"
            })
            : "Unknown";

        return `
            <tr>
                <td>${esc(dateTime)}</td>
                <td>${esc(item.username || "Unknown")}</td>
                <td>${esc(item.action || "—")}</td>
                <td>${esc(item.browser || "Unknown")}</td>
                <td>${esc(item.description || "—")}</td>
            </tr>
        `;
    }).join("");
}

async function refreshActivityLogs() {
    const table = $("activityTable");
    if (!table) return;

    table.innerHTML = '<tr><td colspan="5" class="muted">Loading activity logs...</td></tr>';

    try {
        activityLogs = await api("GET", "/api/activity-logs");
        if (!Array.isArray(activityLogs)) activityLogs = [];
        renderActivityLogs();
    } catch (err) {
        activityLogs = [];
        table.innerHTML =
            `<tr><td colspan="5" class="error">${esc(err.message)}</td></tr>`;
    }
}

$("refreshActivityBtn").addEventListener("click", refreshActivityLogs);