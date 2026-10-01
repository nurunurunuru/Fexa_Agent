const fs = require("fs");
const path = require("path");

const { connectMongoDB, getDB } = require("./mongodb");

const LEADS_COLLECTION = "agent_leads";

const LEADS_DIR = path.join(
  __dirname,
  "..",
  "data",
  "leads"
);

if (!fs.existsSync(LEADS_DIR)) {
  fs.mkdirSync(LEADS_DIR, { recursive: true });
}

async function initLeads() {
  await connectMongoDB();

  const collection = getDB().collection(LEADS_COLLECTION);

  await collection.createIndex({
    agentId: 1,
    timestamp: -1,
  });

  await collection.createIndex({
    agentId: 1,
    sessionId: 1,
  });

  // পুরোনো local lead files migrate করার চেষ্টা।
  const files = fs
    .readdirSync(LEADS_DIR)
    .filter((file) => file.endsWith(".json"));

  for (const file of files) {
    const filePath = path.join(LEADS_DIR, file);
    const agentId = path.basename(file, ".json");

    try {
      const oldLeads = JSON.parse(
        fs.readFileSync(filePath, "utf-8")
      );

      if (!Array.isArray(oldLeads) || oldLeads.length === 0) {
        continue;
      }

      const existingCount = await collection.countDocuments({
        agentId,
      });

      if (existingCount > 0) {
        continue;
      }

      const documents = oldLeads.slice(0, 500).map((lead) => ({
        agentId,
        name: lead.name || "",
        phone: lead.phone || "",
        email: lead.email || "",
        sessionId: lead.sessionId || "",
        transcript: Array.isArray(lead.transcript)
          ? lead.transcript
          : [],
        timestamp:
          lead.timestamp || new Date().toISOString(),
        ...(lead.updatedAt
          ? { updatedAt: lead.updatedAt }
          : {}),
      }));

      await collection.insertMany(documents);

      console.log(
        `✅ Migrated ${documents.length} leads for ${agentId}`
      );
    } catch (error) {
      console.error(
        `⚠️ Lead migration failed for ${agentId}:`,
        error.message
      );
    }
  }
}

async function addLead(agentId, lead) {
  const collection = getDB().collection(LEADS_COLLECTION);

  const transcript = Array.isArray(lead.transcript)
    ? lead.transcript
    : [];

  if (lead.sessionId) {
    const existing = await collection.findOne({
      agentId,
      sessionId: lead.sessionId,
    });

    if (existing) {
      await collection.updateOne(
        { _id: existing._id },
        {
          $push: {
            transcript: { $each: transcript },
          },
          $set: {
            updatedAt: new Date().toISOString(),
          },
        }
      );

      return;
    }
  }

  await collection.insertOne({
    agentId,
    name: lead.name || "",
    phone: lead.phone || "",
    email: lead.email || "",
    sessionId: lead.sessionId || "",
    transcript,
    timestamp: new Date().toISOString(),
  });

  // আগের implementation-এর মতো সর্বোচ্চ 500টি lead রাখা।
  const oldLeads = await collection
    .find({ agentId })
    .sort({ timestamp: -1 })
    .skip(500)
    .project({ _id: 1 })
    .toArray();

  if (oldLeads.length > 0) {
    await collection.deleteMany({
      _id: {
        $in: oldLeads.map((leadItem) => leadItem._id),
      },
    });
  }
}

async function getLeads(agentId) {
  const collection = getDB().collection(LEADS_COLLECTION);

  const documents = await collection
    .find({ agentId })
    .sort({ timestamp: -1 })
    .limit(500)
    .toArray();

  return documents.map(({ _id, agentId: storedAgentId, ...lead }) => lead);
}

module.exports = {
  initLeads,
  addLead,
  getLeads,
};