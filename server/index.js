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

    const body = req.body || {};

    // ---- আগের agent রিফ্রেশ (একই agentId, তাই ক্লায়েন্টের সাইটের embed snippet বদলাতে হয় না) ----
    // body: { agentId, adminKey }  (websiteUrl/phone/... না দিলে আগেরগুলোই থাকবে)
    let existing = null;

    if (body.agentId) {
      const wantedId = String(body.agentId);

      if (!/^[0-9a-fA-F-]{36}$/.test(wantedId)) {
        return res.status(400).json({ error: "agentId ঠিক নেই" });
      }

      existing = vectorStore.loadStore(wantedId);

      if (!existing) {
        return res.status(404).json({ error: "agent পাওয়া যায়নি" });
      }

      if (!body.adminKey || body.adminKey !== existing.adminKey) {
        return res.status(401).json({ error: "ভুল বা মিসিং adminKey" });
      }
    }

    const pick = (v, old, fallback = "") =>
      v !== undefined && v !== null && v !== "" ? v : (old ?? fallback);

    const websiteUrl = pick(body.websiteUrl, existing && existing.siteUrl);
    const phone = pick(body.phone, existing && existing.contactInfo && existing.contactInfo.phone);
    const email = pick(body.email, existing && existing.contactInfo && existing.contactInfo.email);
    const address = pick(body.address, existing && existing.contactInfo && existing.contactInfo.address);
    const siteName = pick(body.siteName, existing && existing.siteName);
    const representativeName = pick(body.representativeName, existing && existing.representativeName);
    const systemPrompt = pick(body.systemPrompt, existing && existing.systemPrompt);
    const { maxPages, maxDepth } = body;

    if (!websiteUrl) return res.status(400).json({ error: "websiteUrl আবশ্যক" });

    const agentId = existing ? existing.agentId : uuidv4();
    const adminKey = existing ? existing.adminKey : crypto.randomBytes(16).toString("hex");
    console.log(`[train] শুরু: ${websiteUrl} -> agentId ${agentId}${existing ? " (refresh)" : ""}`);

    // maxPages না দিলে scraper এর default (১০০ পেজ) ব্যবহার হবে
    const { pages } = await crawlWebsite(websiteUrl, { maxPages, maxDepth });
    if (!pages.length) {
      return res.status(422).json({ error: "কোনো কনটেন্ট বের করা গেল না, URL চেক করুন" });
    }

    const rawChunks = [];
    for (const page of pages) {
      const parts = chunkText(page.text);

      // ছোট পেজ (যেমন কয়েক লাইনের Contact পেজ) থেকে chunk না হলেও পেজটা রাখা হয়,
      // নইলে agent ওই পেজ চিনতে বা খুলে দিতে পারত না।
      if (parts.length === 0 && page.text && page.text.trim()) {
        parts.push(page.text.trim());
      }

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

    await vectorStore.saveStore(agentId, {
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
      refreshed: !!existing,
      pagesTrained: pages.length,
      pageList: pages.map((p) => p.url),
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
app.get("/api/agent/:agentId/leads", async (req, res) => {
  try {
    const store = vectorStore.loadStore(req.params.agentId);

    if (!store) {
      return res.status(404).json({
        error: "agent পাওয়া যায়নি",
      });
    }

    const key = req.query.key;

    if (!key || key !== store.adminKey) {
      return res.status(401).json({
        error: "ভুল বা মিসিং admin key",
      });
    }

    const leadList = await leads.getLeads(store.agentId);

    res.json({
      agentId: store.agentId,
      siteName: store.siteName,
      leads: leadList,
    });
  } catch (error) {
    console.error("Leads fetch error:", error);

    res.status(500).json({
      error: "Failed to load leads",
    });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/voice" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const agentId = url.searchParams.get("agentId");
  const customerName = url.searchParams.get("name") || "";
  const customerPhone = url.searchParams.get("phone") || "";
  const customerEmail = url.searchParams.get("email") || "";

  // Page navigation / auto-resume এর জন্য widget যা পাঠায়:
  //   sid    = একটা call এর unique id (পেজ বদলালেও একই থাকে)
  //   page   = customer এখন ব্রাউজারে যে URL দেখছে
  //   resume = "1" হলে এটা আগের call এরই continuation (পেজ খোলার পর reconnect)
  //   nav    = "agent" (agent পেজ খুলেছে) | "manual" (customer নিজে অন্য পেজে গেছে)
  const sessionId = (url.searchParams.get("sid") || "").slice(0, 64);
  const currentPage = (url.searchParams.get("page") || "").slice(0, 500);
  const isResume = url.searchParams.get("resume") === "1";
  const navReason = url.searchParams.get("nav") === "manual" ? "manual" : "agent";

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
  // resume হলে (পেজ খোলার পর reconnect) একই কলের জন্য আবার notification পাঠানো হয় না
  if (!isResume) sendTelegramNotification(
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
    sessionId,
    currentPage,
    isResume,
    navReason,
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

async function startServer() {
  try {
    await vectorStore.initVectorStore();
    await leads.initLeads();

    server.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server চলছে: http://localhost:${PORT}`);
      console.log(`   Train:  POST http://localhost:${PORT}/api/train`);
      console.log(`   Widget: GET  http://localhost:${PORT}/widget.js`);
      console.log(`   Voice:  WS   ws://localhost:${PORT}/ws/voice?agentId=...`);
    });
  } catch (error) {
    console.error("❌ Server startup failed:", error);
    process.exit(1);
  }
}

startServer();
