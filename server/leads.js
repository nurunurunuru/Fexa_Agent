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

function writeLeads(agentId, list) {
  // একটা agent এ বেশি leads জমে গেলে ফাইল যেন খুব বড় না হয়ে যায়
  // (transcript soho thakay entry gulo age theke boro, tai limit kom rakha holo)
  const trimmed = list.slice(0, 500);

  fs.writeFileSync(
    leadsPath(agentId),
    JSON.stringify(trimmed, null, 2),
    "utf-8"
  );
}

function addLead(agentId, lead) {
  const list = getLeads(agentId);
  const transcript = Array.isArray(lead.transcript) ? lead.transcript : [];

  // Agent যখন কাস্টমারকে কোনো পেজ খুলে দেয়, ব্রাউজার রিলোড হয় আর call টা
  // নতুন WebSocket এ auto-resume হয়। একই call (sessionId) এর transcript যেন
  // আলাদা আলাদা lead না হয়ে একটা lead এই জোড়া লাগে, সেজন্য sessionId দিয়ে merge করা হয়।
  if (lead.sessionId) {
    const existing = list.find((l) => l.sessionId === lead.sessionId);

    if (existing) {
      existing.transcript = (existing.transcript || []).concat(transcript);
      existing.updatedAt = new Date().toISOString();
      writeLeads(agentId, list);
      return;
    }
  }

  list.unshift({
    name: lead.name || "",
    phone: lead.phone || "",
    email: lead.email || "",
    sessionId: lead.sessionId || "",
    transcript,
    timestamp: new Date().toISOString(),
  });

  writeLeads(agentId, list);
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
