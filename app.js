
"use strict";

const $ = id => document.getElementById(id);

const USERNAME = "admin";
const PASSWORD = "admin123";

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

const starterPeople = [
  {
    id: "ARUGA-001",
    name: "Juan Dela Cruz",
    category: "Senior Citizen",
    contact: "09123456789",
    medicineCap: 1500,
    groceryCap: 2500
  },
  {
    id: "ARUGA-002",
    name: "Maria Santos",
    category: "PWD",
    contact: "09987654321",
    medicineCap: 1500,
    groceryCap: 2500
  }
];

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

let beneficiaries = load("aruga_beneficiaries", starterPeople);
let purchases = load("aruga_purchases", []);
let fraudEvents = load("aruga_fraud_events", []);

let qrScanner = null;
let faceStream = null;
let faceVerifiedBeneficiaryId = "";

function save() {
  localStorage.setItem("aruga_beneficiaries", JSON.stringify(beneficiaries));
  localStorage.setItem("aruga_purchases", JSON.stringify(purchases));
  localStorage.setItem("aruga_fraud_events", JSON.stringify(fraudEvents));
}

function makeId() {
  return "P" + Date.now().toString(36) +
    Math.random().toString(36).slice(2,7).toUpperCase();
}

function receiptNumber() {
  const prefix = "ARU-" + today().replaceAll("-", "") + "-";
  const nums = purchases
    .filter(p => p.receiptNo?.startsWith(prefix))
    .map(p => Number(p.receiptNo.slice(prefix.length)) || 0);

  return prefix + String(Math.max(0, ...nums) + 1).padStart(4, "0");
}

/* LOGIN */
$("loginForm").addEventListener("submit", e => {
  e.preventDefault();

  if (
    $("username").value.trim() === USERNAME &&
    $("password").value === PASSWORD
  ) {
    sessionStorage.setItem("arugaLogin", "1");
    $("loginError").textContent = "";
    showApp();
  } else {
    $("loginError").textContent = "Incorrect username or password.";
  }
});

function showApp() {
  $("loginScreen").classList.add("hidden");
  $("appScreen").classList.remove("hidden");
  $("purchaseDate").value = today();
  renderAll();
}

$("logoutBtn").addEventListener("click", () => {
  sessionStorage.removeItem("arugaLogin");
  stopQrScanner();
  stopFaceCamera();
  $("appScreen").classList.add("hidden");
  $("loginScreen").classList.remove("hidden");
  $("loginForm").reset();
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
    analytics: "Budget Analytics"
  })[name];

  if (name !== "purchases") {
    stopQrScanner();
    stopFaceCamera();
  }

  renderAll();
}

/* BENEFICIARY CRUD */
$("beneficiaryForm").addEventListener("submit", e => {
  e.preventDefault();

  const oldId = $("beneficiaryEditId").value;

  const r = {
    id: $("beneficiaryId").value.trim().toUpperCase(),
    name: $("beneficiaryName").value.trim(),
    category: $("beneficiaryCategory").value,
    contact: $("beneficiaryContact").value.trim(),
    medicineCap: Number($("medicineCap").value),
    groceryCap: Number($("groceryCap").value)
  };

  if (!r.id || !r.name || !r.category ||
      r.medicineCap < 0 || r.groceryCap < 0) {
    $("beneficiaryMessage").textContent =
      "Please enter valid information.";
    return;
  }

  if (beneficiaries.some(p => p.id === r.id && p.id !== oldId)) {
    $("beneficiaryMessage").textContent =
      "Beneficiary ID already exists.";
    return;
  }

  if (oldId) {
    const old = beneficiaries.find(p => p.id === oldId);
    if (!old) return;

    Object.assign(old, r);

    purchases.forEach(p => {
      if (p.beneficiaryId === oldId) {
        p.beneficiaryId = r.id;
        p.beneficiaryName = r.name;
      }
    });
  } else {
    beneficiaries.push(r);
  }

  save();
  resetBeneficiary();

  $("beneficiaryMessage").textContent =
    oldId ? "Beneficiary updated." : "Beneficiary added.";

  renderAll();
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

function deletePerson(id) {
  if (purchases.some(p => p.beneficiaryId === id)) {
    alert("This beneficiary has purchase records. Delete those purchase records first.");
    return;
  }

  if (!confirm("Delete beneficiary " + id + "?")) return;

  beneficiaries = beneficiaries.filter(p => p.id !== id);
  save();
  renderAll();
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

/* WEEKLY CAP CALCULATIONS */
function weekStart(s) {
  const d = new Date(s + "T12:00:00");
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

function usedThisWeek(personId, category, date, excludeId = "") {
  const start = weekStart(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  return purchases
    .filter(p =>
      p.id !== excludeId &&
      p.beneficiaryId === personId &&
      p.category === category &&
      new Date(p.date + "T12:00:00") >= start &&
      new Date(p.date + "T12:00:00") < end
    )
    .reduce((s, p) => s + Number(p.amount), 0);
}

/* RECORD BLOCKED DUPLICATE ATTEMPTS */
function logDuplicateAttempt(r, reason) {
  fraudEvents.push({
    id: makeId(),
    attemptedAt: new Date().toISOString(),
    date: r.date || today(),
    beneficiaryId: r.beneficiaryId,
    beneficiaryName: r.beneficiaryName,
    store: r.store,
    category: r.category,
    amount: r.amount,
    voucher: r.voucher,
    reason,
    status: "Blocked duplicate",
    reviewed: false
  });

  save();
  renderAll();
}

function normalizedStore(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/* PURCHASE CREATE / UPDATE AND DUPLICATE BLOCKING */
$("purchaseForm").addEventListener("submit", e => {
  e.preventDefault();

  const editId = $("purchaseEditId").value;

  const person = beneficiaries.find(
    p => p.id === $("purchaseBeneficiary").value
  );

  const r = {
    beneficiaryId: person?.id || "",
    beneficiaryName: person?.name || "",
    store: $("partnerStore").value.trim(),
    category: $("purchaseCategory").value,
    amount: Number($("purchaseAmount").value),
    voucher: $("voucherCode").value.trim(),
    date: $("purchaseDate").value,
    notes: $("purchaseNotes").value.trim()
  };

  const msg = $("purchaseMessage");
  msg.className = "message";

  if (!person) {
    msg.textContent = "Select or scan a registered beneficiary QR code.";
    msg.classList.add("error-message");
    return;
  }

  if (faceVerifiedBeneficiaryId !== person.id) {
    msg.textContent =
      "ERROR — Beneficiary face verification is required. Scan the QR code, start the front camera, and have staff confirm the live face against the official ID/photo.";

    msg.classList.add("error-message");
    return;
  }

  if (!r.store || !r.category || !r.voucher || !r.date ||
      !Number.isFinite(r.amount) || r.amount <= 0) {
    msg.textContent = "Complete all required fields correctly.";
    msg.classList.add("error-message");
    return;
  }

  if (r.date > today()) {
    msg.textContent = "Future transaction dates are not allowed.";
    msg.classList.add("error-message");
    return;
  }

  /* CHECK IF VOUCHER WAS ALREADY USED */
  const duplicateVoucher = purchases.find(p =>
    String(p.voucher || "").trim().toLowerCase() ===
    r.voucher.trim().toLowerCase() &&
    p.id !== editId
  );

  /* CHECK EXACT MATCHING PURCHASE */
  const duplicatePurchase = purchases.find(p =>
    p.id !== editId &&
    p.beneficiaryId === r.beneficiaryId &&
    p.date === r.date &&
    normalizedStore(p.store) === normalizedStore(r.store) &&
    p.category === r.category &&
    Number(p.amount) === r.amount
  );

  /* CHECK POSSIBLE REPEAT AT A DIFFERENT STORE */
  const sameDaySameBenefit = purchases.find(p =>
    p.id !== editId &&
    p.beneficiaryId === r.beneficiaryId &&
    p.date === r.date &&
    p.category === r.category &&
    Number(p.amount) === r.amount
  );

  const possibleDuplicate = duplicatePurchase || sameDaySameBenefit;

  if (duplicateVoucher || possibleDuplicate) {
    const matched = duplicatePurchase || sameDaySameBenefit;

    const reason = duplicateVoucher
      ? `DUPLICATE VOUCHER CODE: ${r.voucher} was already used on receipt ${duplicateVoucher.receiptNo}.`
      : duplicatePurchase
        ? `DUPLICATE PURCHASE: Same beneficiary, date, store, category, and amount already exist on receipt ${duplicatePurchase.receiptNo}.`
        : `POSSIBLE DUPLICATE: Same beneficiary, date, category, and amount already exist on receipt ${matched.receiptNo}, even though the store differs. Staff review is required.`;

    logDuplicateAttempt(r, reason);

    msg.textContent =
      "ERROR — DUPLICATE PURCHASE BLOCKED. " + reason +
      " No receipt or purchase record was created. This attempt is now visible in Fraud Monitoring.";

    msg.classList.add("error-message");
    openPage("fraud");
    return;
  }

  /* CHECK WEEKLY CAP */
  const cap = r.category === "Medicine"
    ? person.medicineCap
    : person.groceryCap;

  const used = usedThisWeek(
    r.beneficiaryId,
    r.category,
    r.date,
    editId
  );

  const reasons = [];

  if (used + r.amount > cap) {
    reasons.push("Weekly " + r.category.toLowerCase() + " cap exceeded");
  }

  /* CHECK FREQUENT TRANSACTIONS */
  const from = new Date(r.date + "T12:00:00");
  from.setDate(from.getDate() - 6);

  const freq = purchases.filter(p =>
    p.id !== editId &&
    p.beneficiaryId === r.beneficiaryId &&
    new Date(p.date + "T12:00:00") >= from &&
    new Date(p.date + "T12:00:00") <=
      new Date(r.date + "T12:00:00")
  ).length;

  if (freq >= 3) {
    reasons.push("Frequent transactions within seven days");
  }

  let saved;

  if (editId) {
    saved = purchases.find(p => p.id === editId);
    if (!saved) return;

    Object.assign(saved, r, {
      reasons,
      status: reasons.length ? "Flagged" : "Normal",
      reviewed: false
    });

    msg.textContent =
      "Purchase updated. Print the revised receipt if needed.";
  } else {
    saved = {
      id: makeId(),
      receiptNo: receiptNumber(),
      ...r,
      reasons,
      status: reasons.length ? "Flagged" : "Normal",
      reviewed: false,
      createdAt: new Date().toISOString()
    };

    purchases.push(saved);
    msg.textContent = "Purchase saved. Receipt generated successfully.";
  }

  save();
  resetPurchase();
  renderAll();
  showReceipt(saved.id);
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
  const p = purchases.find(x => x.id === id);
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

function deletePurchase(id) {
  if (!confirm("Delete this purchase record? Its amount will be removed from recorded spending totals.")) return;

  purchases = purchases.filter(p => p.id !== id);
  save();
  renderAll();
}

/* RECEIPT PREVIEW */
function showReceipt(id) {
  const p = purchases.find(x => x.id === id);
  if (!p) return;

  const person = beneficiaries.find(x => x.id === p.beneficiaryId);
  const cap = person
    ? (p.category === "Medicine" ? person.medicineCap : person.groceryCap)
    : 0;

  const used = usedThisWeek(p.beneficiaryId, p.category, p.date);
  const remaining = Math.max(0, cap - used);

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

  const list = [...purchases].reverse().filter(p =>
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

  $("recentTable").innerHTML = [...purchases].reverse().slice(0, 5).map(p => `
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

/* FRAUD MONITORING */
function renderFraud() {
  const purchaseFlags = purchases
    .filter(p => p.status === "Flagged")
    .map(p => ({
      kind: "purchase",
      id: p.id,
      attemptedAt: p.createdAt || p.date,
      date: p.date,
      beneficiaryId: p.beneficiaryId,
      name: p.beneficiaryName,
      store: p.store,
      category: p.category,
      amount: p.amount,
      voucher: p.voucher,
      reason: (p.reasons || []).join("; "),
      reviewed: p.reviewed
    }));

  const attempts = fraudEvents.map(a => ({
    kind: "attempt",
    id: a.id,
    attemptedAt: a.attemptedAt,
    date: a.date,
    beneficiaryId: a.beneficiaryId,
    name: a.beneficiaryName,
    store: a.store,
    category: a.category,
    amount: a.amount,
    voucher: a.voucher,
    reason: a.reason,
    reviewed: a.reviewed
  }));

  const rows = [...attempts, ...purchaseFlags].sort(
    (a, b) => new Date(b.attemptedAt || b.date) -
              new Date(a.attemptedAt || a.date)
  );

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
  const total = purchases.reduce((s, p) => s + Number(p.amount), 0);

  $("beneficiaryCount").textContent = beneficiaries.length;
  $("purchaseCount").textContent = purchases.length;
  $("totalSpending").textContent = money(total);

  $("flagCount").textContent =
    purchases.filter(p => p.status === "Flagged" && !p.reviewed).length +
    fraudEvents.filter(a => !a.reviewed).length;
}

/* BUDGET ANALYTICS */
function renderAnalytics() {
  const monthly = {};

  purchases.forEach(p => {
    const k = p.date.slice(0, 7);
    monthly[k] = (monthly[k] || 0) + Number(p.amount);
  });

  const now = new Date();
  const keys = [];

  for (let i = 2; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`);
  }

  const avg = keys.reduce((s, k) => s + (monthly[k] || 0), 0) / 3;
  const total = purchases.reduce((s, p) => s + Number(p.amount), 0);

  $("analyticsTotal").textContent = money(total);
  $("monthlyAverage").textContent = money(avg);
  $("forecastAmount").textContent = money(avg);

  const chart = keys.map(k => ({
    label: k,
    amount: monthly[k] || 0
  }));

  chart.push({ label: "Estimate", amount: avg });

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

    case "review-purchase": {
      const p = purchases.find(x => x.id === id);
      if (p) {
        p.reviewed = true;
        save();
        renderAll();
      }
      break;
    }

    case "review-attempt": {
      const a = fraudEvents.find(x => x.id === id);
      if (a) {
        a.reviewed = true;
        save();
        renderAll();
      }
      break;
    }
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
}

/* RESTORE LOGIN SESSION */
if (sessionStorage.getItem("arugaLogin") === "1") {
  showApp();
} else {
  $("loginScreen").classList.remove("hidden");
  $("appScreen").classList.add("hidden");
}
