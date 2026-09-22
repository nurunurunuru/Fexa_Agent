// server/leads.js
// প্রতিটা agent (ওয়েবসাইট) এর customer leads (নাম/ফোন/ইমেইল + সময়) আলাদা
// JSON ফাইলে সেভ রাখা হয়, যাতে admin webpage থেকে দেখা যায়।

const fs = require("fs");
const path = require("path");

const LEADS_DIR = path.join(__dirname, "..", "data", "leads");
if (!fs.existsSync(LEADS_DIR)) fs.mkdirSync(LEADS_DIR, { recursive: true });

function leadsPath(agentId) {
  return path.join(LEADS_DIR, `${agentId}.json`);
}

function addLead(agentId, lead) {
  const list = getLeads(agentId);

  list.unshift({
    name: lead.name || "",
    phone: lead.phone || "",
    email: lead.email || "",
    transcript: Array.isArray(lead.transcript) ? lead.transcript : [],
    timestamp: new Date().toISOString(),
  });

  // একটা agent এ বেশি leads জমে গেলে ফাইল যেন খুব বড় না হয়ে যায়
  // (transcript soho thakay entry gulo age theke boro, tai limit kom rakha holo)
  const trimmed = list.slice(0, 500);

  fs.writeFileSync(
    leadsPath(agentId),
    JSON.stringify(trimmed, null, 2),
    "utf-8"
  );
}

function getLeads(agentId) {
  const p = leadsPath(agentId);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    return [];
  }
}

module.exports = { addLead, getLeads };
