// server/messagingReply.js
// ============================================================
// Facebook Messenger + Instagram DM (ManyChat এর মাধ্যমে)
//
// কীভাবে কাজ করে:
// 1. Customer আপনার Facebook/Instagram Page এ মেসেজ পাঠায়
// 2. ManyChat সেই মেসেজ "External Request" দিয়ে আমাদের এই সার্ভারে পাঠায়
// 3. আমরা একই ওয়েবসাইট-ট্রেইনড knowledge base (vectorStore) থেকে
//    প্রাসঙ্গিক তথ্য খুঁজে বের করি (RAG)
// 4. Gemini text API দিয়ে reply generate করি
// 5. ManyChat কে reply ফেরত পাঠাই, ManyChat সেটা customer কে পাঠায়
//
// এখানে Meta App / webhook / access token কিছুই লাগে না —
// ManyChat নিজে সব Facebook/Instagram এর সাথে যোগাযোগ সামলায়।
// ============================================================

const vectorStore = require("./vectorStore");
const { embedText } = require("./embeddings");
const leads = require("./leads");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_TEXT_MODEL =
  process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";

// প্রতিটা customer এর সাম্প্রতিক কথোপকথন সংক্ষেপে মেমোরিতে রাখা হয়
// (server restart হলে মুছে যাবে, খুব সাধারণ ইন-মেমোরি history)
const conversationHistory = new Map(); // key: senderId, value: [{role, text}]
const HISTORY_LIMIT = 10;

function pushHistory(senderId, role, text) {
  const list = conversationHistory.get(senderId) || [];
  list.push({ role, text });
  while (list.length > HISTORY_LIMIT) list.shift();
  conversationHistory.set(senderId, list);
}

function getHistory(senderId) {
  return conversationHistory.get(senderId) || [];
}

// ------------------------------------------------------------
// RAG: প্রাসঙ্গিক তথ্য খোঁজা
// ------------------------------------------------------------

async function searchKnowledge(agentId, query) {
  try {
    const qEmbedding = await embedText(GEMINI_API_KEY, query);
    const top = vectorStore.search(agentId, qEmbedding, 4);
    if (!top || top.length === 0) return "";
    return top.map((t) => t.text || t.chunk || "").join("\n---\n");
  } catch (e) {
    console.error("[messaging] RAG search error:", e.message);
    return "";
  }
}

// ------------------------------------------------------------
// Gemini দিয়ে টেক্সট reply generate করা
// ------------------------------------------------------------

async function generateReply({ agentStore, senderId, userMessage }) {
  const context = await searchKnowledge(agentStore.agentId, userMessage);

  const systemPrompt =
    agentStore.systemPrompt ||
    `আপনি "${agentStore.siteName}" ওয়েবসাইট/পেজের একজন সহায়ক কাস্টমার সাপোর্ট এজেন্ট। শুধু এই ব্যবসা সম্পর্কিত প্রশ্নের উত্তর দিন। উত্তর সংক্ষিপ্ত ও বন্ধুত্বপূর্ণ রাখুন। কাস্টমার যে ভাষায় লিখেছে, সেই ভাষাতেই উত্তর দিন।`;

  const history = getHistory(senderId);

  const historyText = history
    .map((h) => `${h.role === "user" ? "Customer" : "Agent"}: ${h.text}`)
    .join("\n");

  const prompt =
    `${systemPrompt}\n\n` +
    (context
      ? `ওয়েবসাইট থেকে প্রাসঙ্গিক তথ্য:\n${context}\n\n`
      : "") +
    (historyText ? `আগের কথোপকথন:\n${historyText}\n\n` : "") +
    `Customer: ${userMessage}\nAgent:`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
    }
  );

  const data = await res.json();

  const replyText =
    data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
    "দুঃখিত, এই মুহূর্তে উত্তর দিতে পারছি না। একটু পরে আবার চেষ্টা করুন।";

  return replyText;
}

// ------------------------------------------------------------
// MANYCHAT ENDPOINT
// ------------------------------------------------------------
//
// ManyChat এর "External Request" ফিচার থেকে এই endpoint কল হবে।
// URL এ ?agentId=xxx দিয়ে বলে দিতে হবে কোন client এর knowledge base
// ব্যবহার হবে (প্রতিটা ManyChat bot/flow আলাদা agentId এর সাথে যুক্ত)।
//
// ManyChat কে যা রিটার্ন করা হয় (v2 format, ManyChat এই ফরম্যাট বোঝে):
// { "version": "v2", "content": { "messages": [{ "type": "text", "text": "..." }] } }

async function handleManyChatRequest(req, res) {
  try {
    const agentId = req.query.agentId;

    if (!agentId) {
      return res.status(400).json({ error: "agentId query param দিতে হবে" });
    }

    const agentStore = vectorStore.loadStore(agentId);
    if (!agentStore) {
      return res.status(404).json({ error: "agent পাওয়া যায়নি" });
    }

    // ManyChat এর External Request এ আপনি body তে এই field গুলো ম্যাপ করে
    // পাঠাবেন (গাইডে দেখানো হয়েছে কীভাবে)
    const senderId =
      req.body?.subscriber_id || req.body?.id || "manychat-unknown";

    const userMessage =
      req.body?.message ||
      req.body?.last_input_text ||
      req.body?.text ||
      "";

    if (!userMessage) {
      return res.json({
        version: "v2",
        content: {
          messages: [
            { type: "text", text: "দুঃখিত, মেসেজটা বুঝতে পারিনি।" },
          ],
        },
      });
    }

    pushHistory(senderId, "user", userMessage);

    // প্রথমবার মেসেজ করলে leads এ সেভ করি
    leads.addLead(agentId, {
      name: "Facebook/Instagram (ManyChat) user",
      phone: "",
      email: senderId,
    });

    const replyText = await generateReply({
      agentStore,
      senderId,
      userMessage,
    });

    pushHistory(senderId, "agent", replyText);

    return res.json({
      version: "v2",
      content: {
        messages: [{ type: "text", text: replyText }],
      },
    });
  } catch (e) {
    console.error("[manychat] error:", e.message);
    return res.status(500).json({
      version: "v2",
      content: {
        messages: [
          {
            type: "text",
            text: "দুঃখিত, এই মুহূর্তে সমস্যা হচ্ছে। একটু পরে চেষ্টা করুন।",
          },
        ],
      },
    });
  }
}

module.exports = {
  handleManyChatRequest,
};