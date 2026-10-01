const { MongoClient } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || "fexa-agent";

let client = null;
let db = null;
let connectingPromise = null;

async function connectMongoDB() {
  if (db) return db;

  if (connectingPromise) {
    return connectingPromise;
  }

  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI environment variable is missing");
  }

  connectingPromise = (async () => {
    client = new MongoClient(MONGODB_URI);

    await client.connect();

    db = client.db(DB_NAME);

    console.log("✅ MongoDB connected successfully");

    return db;
  })();

  try {
    return await connectingPromise;
  } catch (error) {
    connectingPromise = null;
    client = null;
    db = null;
    throw error;
  }
}

function getDB() {
  if (!db) {
    throw new Error("MongoDB is not initialized. Call connectMongoDB() first.");
  }

  return db;
}

module.exports = {
  connectMongoDB,
  getDB,
};