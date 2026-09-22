# Realtime Voice Agent — যেকোনো ওয়েবসাইটে ইন্টিগ্রেট করার যোগ্য ভয়েস AI

এই প্রজেক্টটা তিনটা অংশ নিয়ে গঠিত:

1. **Backend (Node.js)** — ওয়েবসাইট ক্রল/ট্রেইন করে, আর Gemini Live API-র সাথে ব্রাউজারকে সংযুক্ত করে (WebSocket bridge)।
2. **widget.js** — একটা ছোট এম্বেডেবল স্ক্রিপ্ট, যেটা টার্গেট ওয়েবসাইটের `<body>`-তে বসালে ফ্লোটিং বাটন + ভয়েস UI দেখাবে।
3. **Vector store** — ওয়েবসাইটের কনটেন্ট থেকে RAG (Retrieval-Augmented Generation) এর জন্য।

কীভাবে কাজ করে (ফ্লো):

```
আপনি                    →  POST /api/train {websiteUrl}
                            (সার্ভার ওয়েবসাইট ক্রল করে, chunk+embed করে সেভ করে)
সার্ভার                  →  আপনাকে agentId + <script> স্নিপেট রিটার্ন করে

আপনি                    →  ওই <script> স্নিপেট টার্গেট ওয়েবসাইটের <body> এ বসান

ভিজিটর                  →  ওয়েবসাইটে বাটনে ক্লিক করে
widget.js               →  মাইক অ্যাক্সেস নেয়, WebSocket দিয়ে backend-এ কানেক্ট করে
backend                 →  Gemini Live API-র সাথে কানেক্ট করে, RAG টুল দিয়ে
                            ওয়েবসাইটের ডেটা থেকে উত্তর টেনে ভয়েস রেসপন্স দেয়
```

---

## ১. সেটআপ

```bash
cd realtime-voice-agent
npm install
cp .env.example .env
```

`.env` ফাইলে বসান:

```
GEMINI_API_KEY=আপনার_আসল_key   # https://aistudio.google.com/apikey থেকে ফ্রি নিতে পারবেন
```

> ⚠️ `GEMINI_LIVE_MODEL` এর ডিফল্ট ভ্যালু কোডে দেওয়া আছে, কিন্তু Google মাঝেমধ্যে মডেলের নাম বদলায়/নতুন ভার্সন আনে। ডিপ্লয় করার আগে অবশ্যই যাচাই করুন: https://ai.google.dev/gemini-api/docs/live-api — যদি "model not found" এরর আসে, `.env` এ `GEMINI_LIVE_MODEL` আপডেট করে দিন।

সার্ভার চালু করুন:

```bash
npm start
```

লোকালি টেস্ট করার সময় (যেহেতু মাইক্রোফোনের জন্য HTTPS লাগে) `localhost` এ ব্রাউজার সাধারণত অনুমতি দেয়, কিন্তু প্রোডাকশনে **অবশ্যই HTTPS/WSS লাগবে** (নিচে দেখুন)।

---

## ২. ওয়েবসাইট ট্রেইন করা

```bash
curl -X POST http://localhost:8080/api/train \
  -H "Content-Type: application/json" \
  -d '{
    "websiteUrl": "https://your-client-website.com",
    "siteName": "আপনার ব্র্যান্ডের নাম",
    "maxPages": 20
  }'
```

রেসপন্স:

```json
{
  "agentId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "pagesTrained": 14,
  "chunksCreated": 132,
  "embedSnippet": "<script src=\"http://localhost:8080/widget.js\" data-agent-id=\"xxxx\" data-server=\"http://localhost:8080\" async></script>"
}
```

এটা স্বয়ংক্রিয়ভাবে ওয়েবসাইটের একই ডোমেইনের ভেতরের লিংক ধরে ধরে (max depth 2, max pages 20 — `.env`/request body দিয়ে বদলানো যায়) সব পেজের টেক্সট বের করে, ছোট ছোট chunk করে Gemini embedding দিয়ে ভেক্টরে রূপান্তর করে `data/<agentId>.json` এ সেভ করে রাখে।

চাইলে `systemPrompt` কাস্টমও পাঠাতে পারেন (এজেন্টের persona/টোন কেমন হবে):

```json
{
  "websiteUrl": "...",
  "systemPrompt": "তুমি XYZ Fashion Store এর সহায়ক, সবসময় বাংলায় বন্ধুত্বপূর্ণভাবে কথা বলবে..."
}
```

---

## ৩. টার্গেট ওয়েবসাইটে বসানো

`/api/train` এর রেসপন্সে পাওয়া `embedSnippet` টা কপি করে টার্গেট ওয়েবসাইটের HTML-এ `</body>` এর ঠিক আগে বসিয়ে দিন:

```html
<script
  src="https://your-server.com/widget.js"
  data-agent-id="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  data-server="https://your-server.com"
  data-name="আপনার ব্র্যান্ডের নাম"
  data-color="#6d28d9"
  async
></script>
```

Optional attribute:
- `data-name` — উইজেটের হেডারে যে নাম দেখাবে
- `data-color` — থিম কালার (hex)

ব্যাস — এখন ওয়েবসাইটে একটা ফ্লোটিং মাইক বাটন দেখা যাবে, ক্লিক করলে ভয়েস প্যানেল খুলবে।

---

## ৪. প্রোডাকশন ডিপ্লয়মেন্টে যা মনে রাখবেন

- **HTTPS/WSS বাধ্যতামূলক** — ব্রাউজার HTTPS ছাড়া মাইক্রোফোন পারমিশন দেয় না (localhost ছাড়া)। Railway/Render/Fly.io/আপনার VPS+nginx+certbot যেকোনো কিছুতে ডিপ্লয় করলে এমনিতেই HTTPS পাবেন।
- **`ALLOWED_ORIGINS`** — `.env` এ যেসব ওয়েবসাইট এই widget ব্যবহার করবে তাদের ডোমেইন কমা দিয়ে বসান (প্রোডাকশনে `*` না রাখাই ভালো)।
- **GEMINI_API_KEY কখনো ব্রাউজারে পাঠাবেন না** — এই আর্কিটেকচারে key শুধু backend-এ থাকে, browser শুধু আপনার backend-এর সাথে কথা বলে, এটাই ইচ্ছাকৃতভাবে করা হয়েছে।
- **Rate limiting/billing** — Gemini Live API ব্যবহারে খরচ হয় (per-minute audio pricing)। প্রোডাকশনে গেলে `/api/train` ও `/ws/voice` এ rate limiting/auth যোগ করুন, নাহলে যে কেউ আপনার সার্ভার/বিল অপব্যবহার করতে পারবে।
- **Vector store scale** — এখন সবকিছু JSON ফাইলে; কয়েকশ পেজ পর্যন্ত ঠিক আছে। বড় সাইটের জন্য `server/vectorStore.js` কে Pinecone/Qdrant/pgvector দিয়ে replace করে দিতে পারবেন — বাকি কোড অপরিবর্তিত থাকবে (একই ইন্টারফেস রেখে দিন: `search(agentId, embedding, topK)`)।
- **Re-training** — ওয়েবসাইট আপডেট হলে আবার `/api/train` কল করলে নতুন `agentId` তৈরি হবে; পুরনো widget স্নিপেট আপডেট করে নতুন agentId বসাতে হবে। চাইলে কোড এক্সটেন্ড করে "একই agentId রিফ্রেশ করা" যোগ করা যায়।

---

## ৫. প্রজেক্ট স্ট্রাকচার

```
realtime-voice-agent/
  server/
    index.js         # Express app: /api/train, /widget.js, WS server bootstrap
    scraper.js        # same-domain website crawler + text chunking
    embeddings.js      # Gemini embedding API wrapper + cosine similarity
    vectorStore.js     # প্রতি agent এর জন্য JSON ফাইলে vector সেভ/সার্চ
    liveSession.js     # browser WS <-> Gemini Live WS bridge + RAG function-calling
  public/
    widget.js          # এম্বেডেবল ক্লায়েন্ট স্ক্রিপ্ট (floating button + ভয়েস UI)
  data/                 # ট্রেইন করা agent-দের vector store (রানটাইমে তৈরি হয়)
  .env.example
  package.json
```

---

## ৬. কীভাবে RAG কাজ করে (voice call চলাকালীন)

সেশন শুরুতে মডেলকে একটা `search_website_info` নামের টুল দেওয়া হয়। ভিজিটর যখন ওয়েবসাইট-নির্দিষ্ট কিছু জিজ্ঞেস করে (যেমন "আপনাদের ডেলিভারি চার্জ কত?"), মডেল নিজে থেকে বুঝে এই টুল কল করে backend-কে। Backend তখন প্রশ্নটা embed করে, vector store এ সবচেয়ে কাছাকাছি ৪টা chunk খুঁজে বের করে মডেলকে ফেরত পাঠায়, আর মডেল সেই তথ্য দিয়ে ভয়েসে উত্তর তৈরি করে। এভাবে মডেল বানিয়ে/অনুমান করে উত্তর না দিয়ে সত্যিকারের ওয়েবসাইট কনটেন্ট থেকে উত্তর দেয়।

---

## ৭. সীমাবদ্ধতা / ভবিষ্যতে যা যোগ করতে পারেন

- এখন শুধু text-heavy পেজ ক্রল হয় (JS-heavy SPA হলে সার্ভার-সাইড রেন্ডারড কনটেন্ট না থাকলে টেক্সট কম পাওয়া যেতে পারে — সেক্ষেত্রে Puppeteer/Playwright দিয়ে crawler আপগ্রেড করতে হবে)
- Analytics/conversation logging নেই — চাইলে `liveSession.js` এ turn-level ডেটা DB তে সেভ করার কোড যোগ করা যায়
- একটাই ভয়েস (`Aoede`) সেট করা আছে — `liveSession.js` এর `voiceConfig` থেকে বদলানো যাবে
- Multi-tenant admin UI নেই (এখন `/api/train` কার্ল/পোস্টম্যান দিয়ে কল করতে হবে) — চাইলে একটা সিম্পল ড্যাশবোর্ড যোগ করে দিতে পারি
