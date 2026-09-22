// server/index.js
require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");

const { crawlWebsite, chunkText } = require("./scraper");
const { embedBatch } = require("./embeddings");
const vectorStore = require("./vectorStore");
const { startBridge } = require("./liveSession");
const leads = require("./leads");
const crypto = require("crypto");
const messagingReply = require("./messagingReply");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL =
  process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramNotification(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
        }),
      }
    );
  } catch (err) {
    console.error("[telegram] notification পাঠাতে ব্যর্থ:", err.message);
  }
}

if (!API_KEY) {
  console.warn("⚠️  GEMINI_API_KEY সেট করা নেই। .env ফাইলে সেট করুন।");
}

// --- CORS (widget.js এবং /api/train কে যেকোনো ক্লায়েন্ট ওয়েবসাইট থেকে কল করার অনুমতি) ---
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes("*") || (origin && ALLOWED_ORIGINS.includes(origin))) {
    res.header("Access-Control-Allow-Origin", origin || "*");
  }
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use("/widget.js", express.static(path.join(__dirname, "..", "public", "widget.js")));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (_req, res) => {
  res.send("Realtime Voice Agent server running ✅");
});

/**
 * POST /api/train
 * body: { websiteUrl, siteName?, maxPages?, systemPrompt? }
 * -> নতুন agentId বানায়, ওয়েবসাইট ক্রল করে, chunk+embed করে vector store এ সেভ করে।
 * -> রেসপন্সে agentId + embed script স্নিপেট রিটার্ন করে।
 */
app.post("/api/train", async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: "Server GEMINI_API_KEY missing" });

    const { websiteUrl, phone, email, address, siteName, representativeName, maxPages, systemPrompt } = req.body || {};
    if (!websiteUrl) return res.status(400).json({ error: "websiteUrl আবশ্যক" });

    const agentId = uuidv4();
    const adminKey = crypto.randomBytes(16).toString("hex");
    console.log(`[train] শুরু: ${websiteUrl} -> agentId ${agentId}`);

    const { pages } = await crawlWebsite(websiteUrl, { maxPages: maxPages || 20 });
    if (!pages.length) {
      return res.status(422).json({ error: "কোনো কনটেন্ট বের করা গেল না, URL চেক করুন" });
    }

    const rawChunks = [];
    for (const page of pages) {
      const parts = chunkText(page.text);
      for (const text of parts) {
        rawChunks.push({ url: page.url, title: page.title, text });
      }
    }
    console.log(`[train] ${pages.length} পেজ থেকে ${rawChunks.length} chunk তৈরি হয়েছে, embedding শুরু...`);

    const embeddings = await embedBatch(
  API_KEY,
  rawChunks.map((c) => c.text),
  {
    batchSize: 50,
  }
);

    const chunks = rawChunks.map((c, i) => ({
      id: uuidv4(),
      url: c.url,
      title: c.title,
      text: c.text,
      embedding: embeddings[i],
    }));

    vectorStore.saveStore(agentId, {
      agentId,
      siteName: siteName || new URL(websiteUrl).hostname,
      representativeName: representativeName || "Faisal",

      contactInfo: {
    phone: phone || "",
    email: email || "",
    address: address || "",
  },

  
      siteUrl: websiteUrl,
      systemPrompt: systemPrompt || "",
      createdAt: new Date().toISOString(),
      pageCount: pages.length,
      adminKey,
      chunks,
    });

    console.log(`[train] ✅ শেষ। agentId=${agentId}`);

    const host = req.get("host");
    const protocol = req.protocol;
    const embedSnippet = `<script src="${protocol}://${host}/widget.js" data-agent-id="${agentId}" data-server="${protocol}://${host}" async></script>`;
    const adminUrl = `${protocol}://${host}/admin.html?agentId=${agentId}&key=${adminKey}`;

    res.json({
      agentId,
      pagesTrained: pages.length,
      chunksCreated: chunks.length,
      embedSnippet,
      adminUrl,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ট্রেইনিং স্ট্যাটাস চেক করার জন্য (ঐচ্ছিক)
app.get("/api/agent/:agentId", (req, res) => {
  const store = vectorStore.loadStore(req.params.agentId);
  if (!store) return res.status(404).json({ error: "agent পাওয়া যায়নি" });
  res.json({
    agentId: store.agentId,
    siteName: store.siteName,
    siteUrl: store.siteUrl,
    createdAt: store.createdAt,
    pageCount: store.pageCount,
    chunkCount: store.chunks.length,
  });
});

/**
 * GET /api/agent/:agentId/leads?key=ADMIN_KEY
 * -> ওই agent এর সাথে কথা বলা customer দের list (নাম/ফোন/ইমেইল/সময়)
 * -> শুধু সঠিক adminKey দিলেই দেখা যাবে (train করার সময় পাওয়া key)
 */
app.get("/api/agent/:agentId/leads", (req, res) => {
  const store = vectorStore.loadStore(req.params.agentId);
  if (!store) return res.status(404).json({ error: "agent পাওয়া যায়নি" });

  const key = req.query.key;
  if (!key || key !== store.adminKey) {
    return res.status(401).json({ error: "ভুল বা মিসিং admin key" });
  }

  res.json({
    agentId: store.agentId,
    siteName: store.siteName,
    leads: leads.getLeads(store.agentId),
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/voice" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const agentId = url.searchParams.get("agentId");
  const customerName = url.searchParams.get("name") || "";
  const customerPhone = url.searchParams.get("phone") || "";
  const customerEmail = url.searchParams.get("email") || "";

  if (!agentId || !vectorStore.agentExists(agentId)) {
    ws.send(JSON.stringify({ type: "error", message: "Invalid or missing agentId" }));
    ws.close();
    return;
  }
  if (!API_KEY) {
    ws.send(JSON.stringify({ type: "error", message: "Server not configured" }));
    ws.close();
    return;
  }

  const store = vectorStore.loadStore(agentId);
  const siteName = store?.siteName || agentId;

  // customer er lead ekhon call SHESH hole (transcript soho) save hoy,
  // eijonyo liveSession.js e customer info pathiye dicchi
  sendTelegramNotification(
    `🔔 <b>নতুন কল শুরু হয়েছে</b>\n` +
    `🌐 সাইট: ${siteName}\n` +
    `👤 নাম: ${customerName || "N/A"}\n` +
    `📞 ফোন: ${customerPhone || "N/A"}\n` +
    `📧 ইমেইল: ${customerEmail || "N/A"}\n` +
    `🕒 সময়: ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Dhaka" })}`
  );

  startBridge(ws, {
    agentId,
    apiKey: API_KEY,
    model: MODEL,
    customerName,
    customerPhone,
    customerEmail,
  });
});

// ============================================================
// FACEBOOK MESSENGER + INSTAGRAM DM (ManyChat এর মাধ্যমে)
// ============================================================

/**
 * ManyChat এর "External Request" ফিচার থেকে কল হবে (Meta App লাগবে না)।
 * URL: https://apnar-domain.com/api/manychat-reply?agentId=xxxxx
 */
app.post("/api/manychat-reply", messagingReply.handleManyChatRequest);

server.listen(PORT,"0.0.0.0", () => {
  console.log(`🚀 Server চলছে: http://localhost:${PORT}`);
  console.log(`   Train:  POST http://localhost:${PORT}/api/train`);
  console.log(`   Widget: GET  http://localhost:${PORT}/widget.js`);
  console.log(`   Voice:  WS   ws://localhost:${PORT}/ws/voice?agentId=...`);
});
