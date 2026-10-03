// Generates data/attendance.json: a daily visit log per member for the
// last 30 days, with counts matching each member's visitsThisMonth in members.json.
const fs = require("fs");
const path = require("path");

const members = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "members.json"), "utf8")
);

const TODAY = new Date("2026-10-03T00:00:00Z");

function daysAgo(n) {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const attendance = {};

for (const m of members) {
  const count = m.visitsThisMonth;
  const log = [];
  // Spread visits evenly across the last 30 days (deterministic, not random,
  // so the mock data is stable every time you regenerate it).
  if (count > 0) {
    const step = 30 / count;
    for (let i = 0; i < count; i++) {
      const offset = Math.round(i * step);
      log.push(daysAgo(offset));
    }
  }
  attendance[m.memberId] = {
    memberId: m.memberId,
    month: "2026-10",
    visitDates: [...new Set(log)].sort(),
    totalVisits: count,
    requiredVisits: m.requiredVisits,
    eligible: count >= m.requiredVisits
  };
}

fs.writeFileSync(
  path.join(__dirname, "data", "attendance.json"),
  JSON.stringify(attendance, null, 2)
);

console.log("Wrote data/attendance.json for", members.length, "members");
