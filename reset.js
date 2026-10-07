// Restores data/members.json to the original 10-member seed state.
// Run after testing renewals: node reset.js
const fs = require("fs");
const path = require("path");

const seedPath = path.join(__dirname, "data", "members.seed.json");
const liveePath = path.join(__dirname, "data", "members.json");

fs.copyFileSync(seedPath, liveePath);
console.log("Reset data/members.json to original seed state.");
