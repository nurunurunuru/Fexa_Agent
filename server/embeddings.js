// server/embeddings.js
// Local AI Embedding System
// No Gemini Embedding API
// No API quota / 429 problem

const { pipeline } = require("@xenova/transformers");

let extractor = null;

// --------------------------------------------------
// Load local embedding model
// --------------------------------------------------

async function getExtractor() {
  if (!extractor) {
    console.log("🧠 Loading local embedding model...");

    extractor = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );

    console.log("✅ Local embedding model loaded");
  }

  return extractor;
}

// --------------------------------------------------
// Generate embedding for one text
// --------------------------------------------------

async function embedText(_apiKey, text) {
  if (!text || typeof text !== "string") {
    throw new Error("Embedding text must be a non-empty string");
  }

  const model = await getExtractor();

  const output = await model(text, {
    pooling: "mean",
    normalize: true,
  });

  return Array.from(output.data);
}

// --------------------------------------------------
// Generate embeddings for many texts
// --------------------------------------------------

async function embedBatch(
  _apiKey,
  texts,
  {
    batchSize = 16,
  } = {}
) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const results = new Array(texts.length);

  console.log(
    `🧠 Local embedding শুরু: ${texts.length} chunks`
  );

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    console.log(
      `🧠 Embedding ${i + 1}-${Math.min(
        i + batch.length,
        texts.length
      )}/${texts.length}`
    );

    const model = await getExtractor();

    const outputs = await Promise.all(
      batch.map(async (text) => {
        const output = await model(text, {
          pooling: "mean",
          normalize: true,
        });

        return Array.from(output.data);
      })
    );

    for (let j = 0; j < outputs.length; j++) {
      results[i + j] = outputs[j];
    }
  }

  console.log("✅ Local embedding complete");

  return results;
}

// --------------------------------------------------
// Cosine similarity
// --------------------------------------------------

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return 0;
  }

  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return (
    dot /
    (Math.sqrt(normA) * Math.sqrt(normB))
  );
}

module.exports = {
  embedText,
  embedBatch,
  cosineSimilarity,
};