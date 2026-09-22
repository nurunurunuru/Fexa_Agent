// server/vectorStore.js
// প্রতিটা agent (মানে প্রতিটা ওয়েবসাইট) এর জন্য আলাদা JSON ফাইলে chunk + embedding
// সেভ করে রাখা হয়। বড় স্কেলে গেলে এটাকে Pinecone/Qdrant/pgvector দিয়ে replace
// করা যাবে, কিন্তু কয়েকশ chunk পর্যন্ত এই সাধারণ ফাইল-ভিত্তিক approach ঠিকঠাক কাজ করে।

const fs = require("fs");
const path = require("path");
const { cosineSimilarity } = require("./embeddings");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function storePath(agentId) {
  return path.join(DATA_DIR, `${agentId}.json`);
}

function saveStore(agentId, store) {
  fs.writeFileSync(storePath(agentId), JSON.stringify(store, null, 2), "utf-8");
}

function loadStore(agentId) {
  const p = storePath(agentId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function agentExists(agentId) {
  return fs.existsSync(storePath(agentId));
}

function listAgents() {
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

/**
 * store shape:
 * {
 *   agentId, siteName, siteUrl, systemPrompt, createdAt,
 *   chunks: [{ id, url, title, text, embedding: number[] }]
 * }
 */

function search(agentId, queryEmbedding, topK = 5) {
  const store = loadStore(agentId);
  if (!store) return [];
  const scored = store.chunks.map((c) => ({
    ...c,
    score: cosineSimilarity(queryEmbedding, c.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

module.exports = { saveStore, loadStore, agentExists, listAgents, search, DATA_DIR };
