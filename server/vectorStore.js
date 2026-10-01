const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { cosineSimilarity } = require("./embeddings");
const { connectMongoDB, getDB } = require("./mongodb");

const AGENTS_COLLECTION = "agents";
const CHUNKS_COLLECTION = "agent_chunks";

const DATA_DIR = path.join(__dirname, "..", "data");

const agentCache = new Map();

async function persistStore(agentId, store) {
  const db = getDB();

  const agentsCollection = db.collection(AGENTS_COLLECTION);
  const chunksCollection = db.collection(CHUNKS_COLLECTION);

  const version = crypto.randomUUID();

  const {
    chunks = [],
    _id,
    ...metadata
  } = store;

  const safeChunks = Array.isArray(chunks) ? chunks : [];

  // নতুন chunk version আগে insert হবে।
  // এতে মাঝপথে save fail করলে আগের version অক্ষত থাকবে।
  if (safeChunks.length > 0) {
    const documents = safeChunks.map((chunk, index) => ({
      agentId,
      version,
      position: index,

      ...(chunk.id !== undefined ? { id: chunk.id } : {}),

      text: chunk.text || "",
      embedding: Array.isArray(chunk.embedding)
        ? chunk.embedding
        : [],
      url: chunk.url || "",
      title: chunk.title || "",
    }));

    await chunksCollection.insertMany(documents);
  }

  // Metadata এখন নতুন chunk version-কে reference করবে।
  await agentsCollection.replaceOne(
    { agentId },
    {
      ...metadata,
      agentId,
      chunkVersion: version,
    },
    { upsert: true }
  );

  // নতুন version active হওয়ার পর পুরোনো chunks delete হবে।
  await chunksCollection.deleteMany({
    agentId,
    version: { $ne: version },
  });

  agentCache.set(agentId, {
    ...metadata,
    agentId,
    chunks: safeChunks,
  });

  console.log(`✅ Agent saved to MongoDB: ${agentId}`);
}

async function migrateLocalAgents() {
  if (!fs.existsSync(DATA_DIR)) return;

  const db = getDB();
  const agentsCollection = db.collection(AGENTS_COLLECTION);

  const files = fs
    .readdirSync(DATA_DIR)
    .filter((file) => file.endsWith(".json"));

  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const store = JSON.parse(raw);

      if (
        !store ||
        typeof store !== "object" ||
        !Array.isArray(store.chunks)
      ) {
        continue;
      }

      const agentId = store.agentId || path.basename(file, ".json");

      const existing = await agentsCollection.findOne({ agentId });

      if (existing) {
        continue;
      }

      await persistStore(agentId, {
        ...store,
        agentId,
      });

      console.log(`✅ Local agent migrated: ${agentId}`);
    } catch (error) {
      console.error(
        `⚠️ Could not migrate ${file}:`,
        error.message
      );
    }
  }
}

async function initVectorStore() {
  await connectMongoDB();

  const db = getDB();

  const agentsCollection = db.collection(AGENTS_COLLECTION);
  const chunksCollection = db.collection(CHUNKS_COLLECTION);

  await agentsCollection.createIndex(
    { agentId: 1 },
    { unique: true }
  );

  await chunksCollection.createIndex({
    agentId: 1,
    version: 1,
    position: 1,
  });

  // পুরোনো local JSON থাকলে migrate করার চেষ্টা।
  await migrateLocalAgents();

  const agents = await agentsCollection.find({}).toArray();

  agentCache.clear();

  for (const agent of agents) {
    const query = { agentId: agent.agentId };

    if (agent.chunkVersion) {
      query.version = agent.chunkVersion;
    }

    const chunks = await chunksCollection
      .find(query)
      .sort({ position: 1 })
      .toArray();

    const cleanChunks = chunks.map((chunk) => ({
      ...(chunk.id !== undefined ? { id: chunk.id } : {}),
      text: chunk.text || "",
      embedding: Array.isArray(chunk.embedding)
        ? chunk.embedding
        : [],
      url: chunk.url || "",
      title: chunk.title || "",
    }));

    const { _id, chunkVersion, ...metadata } = agent;

    agentCache.set(agent.agentId, {
      ...metadata,
      chunks: cleanChunks,
    });
  }

  console.log(
    `✅ Vector store initialized: ${agentCache.size} agent(s)`
  );
}

async function saveStore(agentId, store) {
  await persistStore(agentId, store);
}

function loadStore(agentId) {
  return agentCache.get(agentId) || null;
}

function agentExists(agentId) {
  return agentCache.has(agentId);
}

function listAgents() {
  return Array.from(agentCache.keys());
}

function search(agentId, queryEmbedding, topK = 5) {
  const store = loadStore(agentId);

  if (!store) return [];

  const chunks = Array.isArray(store.chunks)
    ? store.chunks
    : [];

  const scored = chunks.map((chunk) => ({
    ...chunk,
    score: cosineSimilarity(
      queryEmbedding,
      chunk.embedding
    ),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}

module.exports = {
  saveStore,
  loadStore,
  agentExists,
  listAgents,
  search,
  initVectorStore,
};