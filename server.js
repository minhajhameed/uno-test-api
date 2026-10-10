// Mock membership API for testing the HCL Universal Orchestrator
// auto-renewal workflow. Backed by flat JSON files, not a real database --
// swap data/members.json + data/attendance.json for real queries later.
//
// Zero dependencies: runs with plain `node server.js`, no npm install needed.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const DATA_DIR = path.join(__dirname, "data");
const membersPath = path.join(DATA_DIR, "members.json");
const attendancePath = path.join(DATA_DIR, "attendance.json");

// Running on a VPS now (not Vercel's read-only serverless fs), so renewals
// write straight back to members.json and actually persist across restarts.
// Keep data/members.seed.json around if you ever want to reset to defaults.
function loadMembers() {
  return JSON.parse(fs.readFileSync(membersPath, "utf8"));
}
function saveMembers(members) {
  fs.writeFileSync(membersPath, JSON.stringify(members, null, 2));
}
function loadAttendance() {
  return JSON.parse(fs.readFileSync(attendancePath, "utf8"));
}

const TODAY = new Date("2026-10-03T00:00:00Z");
function daysUntil(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  return Math.round((d - TODAY) / 86400000);
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
    "Access-Control-Allow-Origin": "*"
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

// --- Route handlers -------------------------------------------------------

function handleHealth(req, res) {
  sendJson(res, 200, { status: "ok", today: "2026-10-03" });
}

function handleListMembers(req, res) {
  sendJson(res, 200, loadMembers());
}

function handleRenewals(req, res) {
  sendJson(res, 200, {
    customer_id: "cust_987654",
    company_name: "Acme Corp",
    contact_info: {
      primary_contact: "Jane Doe",
      email: "jane.doe@acme.com",
      phone: "+1-555-0198"
    },
    subscription: {
      plan_name: "Enterprise Tier",
      status: "active",
      auto_renew: true,
      billing_cycle: "annual"
    },
    renewal_details: {
      current_period_start: "2025-09-01T00:00:00Z",
      current_period_end: "2026-08-31T23:59:59Z",
      renewal_date: "2026-09-01T00:00:00Z",
      notice_date: "2026-08-01T00:00:00Z"
    },
    financials: {
      currency: "USD",
      contract_value: 12000.00,
      discount_applied: 500.00,
      tax: 920.00,
      total_due: 12420.00
    },
    payment_method: {
      type: "credit_card",
      last_4: "4242",
      expiry_date: "11/28"
    }
  });
}

function handleExpiring(req, res, query) {
  const days = parseInt(query.get("days") || "7", 10);
  const members = loadMembers();
  const expiring = members
    .filter((m) => daysUntil(m.cardExpiryDate) <= days)
    .map((m) => ({
      memberId: m.memberId,
      name: m.name,
      email: m.email,
      planType: m.planType,
      cardExpiryDate: m.cardExpiryDate,
      daysUntilExpiry: daysUntil(m.cardExpiryDate),
      cardStatus: m.cardStatus
    }));
  sendJson(res, 200, { windowDays: days, count: expiring.length, members: expiring });
}

function handleUsage(req, res, memberId) {
  const attendance = loadAttendance();
  const record = attendance[memberId];
  if (!record) return sendJson(res, 404, { error: "member not found" });
  sendJson(res, 200, record);
}

function handleEligibleForRenewal(req, res, query) {
  const days = parseInt(query.get("days") || "7", 10);
  const members = loadMembers();
  const attendance = loadAttendance();

  const eligible = [];
  const notEligible = [];

  for (const m of members) {
    const dLeft = daysUntil(m.cardExpiryDate);
    if (dLeft > days) continue;

    const usage = attendance[m.memberId];
    const entry = {
      memberId: m.memberId,
      name: m.name,
      email: m.email,
      planType: m.planType,
      planName: m.planName,
      monthlyFee: m.monthlyFee,
      cardExpiryDate: m.cardExpiryDate,
      daysUntilExpiry: dLeft,
      visitsThisMonth: usage.totalVisits,
      requiredVisits: usage.requiredVisits
    };

    if (usage.eligible) eligible.push(entry);
    else notEligible.push(entry);
  }

  sendJson(res, 200, { windowDays: days, eligible, notEligible });
}

async function handleRenew(req, res, memberId) {
  const members = loadMembers();
  const idx = members.findIndex((m) => m.memberId === memberId);
  if (idx === -1) return sendJson(res, 404, { error: "member not found" });

  const member = members[idx];

  // Mock payment: memberId ending in a digit divisible by 7 "fails", so you
  // have a deterministic way to test the failure path from UnO. None of the
  // 10 default members trigger this -- change an id or add one to test it.
  const lastDigit = parseInt(member.memberId.slice(-1), 10);
  const chargeSucceeded = lastDigit % 7 !== 0;

  if (!chargeSucceeded) {
    return sendJson(res, 402, {
      memberId: member.memberId,
      charged: false,
      reason: "card_declined_mock"
    });
  }

  const newExpiry = new Date(member.cardExpiryDate + "T00:00:00Z");
  newExpiry.setUTCMonth(newExpiry.getUTCMonth() + 1);
  member.cardExpiryDate = newExpiry.toISOString().slice(0, 10);
  member.cardStatus = "active";
  member.visitsThisMonth = 0;
  members[idx] = member;
  saveMembers(members);

  sendJson(res, 200, {
    memberId: member.memberId,
    charged: true,
    amount: member.monthlyFee,
    newExpiryDate: member.cardExpiryDate,
    transactionId: `TXN-${member.memberId}-${Date.now()}`
  });
}

// --- Router -----------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean); // e.g. ["api","members","M001","usage"]

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return handleHealth(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/members") {
      return handleListMembers(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/v1/renewals") {
      return handleRenewals(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/members/expiring") {
      return handleExpiring(req, res, url.searchParams);
    }
    if (req.method === "GET" && url.pathname === "/api/members/eligible-for-renewal") {
      return handleEligibleForRenewal(req, res, url.searchParams);
    }
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "members" && parts[3] === "usage") {
      return handleUsage(req, res, parts[2]);
    }
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "members" && parts[3] === "renew") {
      await readBody(req); // drain body if any was sent
      return await handleRenew(req, res, parts[2]);
    }

    sendJson(res, 404, { error: "not found", path: url.pathname });
  } catch (err) {
    sendJson(res, 500, { error: "internal_error", message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mock gym/carwash membership API listening on port ${PORT}`);
});
