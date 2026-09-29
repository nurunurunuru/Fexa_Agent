// server/pageFinder.js
// ওয়েবসাইটের কোন পেজে কী আছে — সেটার একটা "site map" বানায়, এবং customer যা চায়
// (যেমন "এই প্রোডাক্টটা দেখাও") তার সাথে সবচেয়ে মিলে যাওয়া পেজ খুঁজে বের করে।
//
// এখানে কোনো embedding/API কল নেই (pure functions), তাই সহজে টেস্ট করা যায়।
// Embedding search এর ফলাফল (hits) liveSession.js থেকে পাঠানো হয়।
//
// store.chunks এ প্রতিটা chunk এর url + title আগে থেকেই সেভ করা আছে, তাই
// পুরনো trained agent গুলো রিট্রেইন না করেই এই ফিচার কাজ করবে।

const pageCache = new Map(); // agentId -> { key, pages }

// ------------------------------------------------------------
// URL helpers
// ------------------------------------------------------------

function parseUrl(u) {
  try {
    return new URL(u);
  } catch (e) {
    return null;
  }
}

// host + path (+ query) — www., trailing slash, #hash ইগনোর করে তুলনা করার জন্য
function normalizeUrl(u, { keepQuery = true } = {}) {
  const x = parseUrl(u);
  if (!x) return String(u || "").trim().toLowerCase();

  const host = x.hostname.toLowerCase().replace(/^www\./, "");
  const pathName = x.pathname.replace(/\/+$/, "") || "/";

  return host + pathName + (keepQuery ? x.search : "");
}

// a = trained পেজের URL, b = customer এর ব্রাউজারের URL।
// trained URL এ query না থাকলে b এর ?utm_source=... জাতীয় extra param ইগনোর করা হয়।
function sameUrl(a, b) {
  if (!a || !b) return false;

  if (normalizeUrl(a) === normalizeUrl(b)) return true;

  const pa = parseUrl(a);
  if (pa && !pa.search) {
    return (
      normalizeUrl(a, { keepQuery: false }) ===
      normalizeUrl(b, { keepQuery: false })
    );
  }

  return false;
}

// ------------------------------------------------------------
// Pages index
// ------------------------------------------------------------

function cleanLine(s, max) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * store.chunks থেকে unique পেজের তালিকা বানায়:
 * [{ url, title, description, text }]
 * text = ওই পেজের সব chunk জোড়া লাগানো (current-page context এর জন্য)
 */
function getPages(store) {
  if (!store || !Array.isArray(store.chunks)) return [];

  const key = `${store.createdAt || ""}:${store.chunks.length}`;
  const cached = pageCache.get(store.agentId);
  if (cached && cached.key === key) return cached.pages;

  const byUrl = new Map();

  for (const c of store.chunks) {
    if (!c || !c.url) continue;

    let page = byUrl.get(c.url);

    if (!page) {
      const desc = /^Description:\s*(.+)$/m.exec(c.text || "");

      page = {
        url: c.url,
        title: cleanLine(c.title || c.url, 120),
        description: desc ? cleanLine(desc[1], 110) : "",
        parts: [],
      };

      byUrl.set(c.url, page);
    }

    page.parts.push(c.text || "");
  }

  const pages = Array.from(byUrl.values()).map((p) => ({
    url: p.url,
    title: p.title,
    description: p.description,
    text: p.parts.join("\n"),
  }));

  if (store.agentId) pageCache.set(store.agentId, { key, pages });

  return pages;
}

/**
 * URL দিয়ে পেজ খোঁজে। আগে query সহ exact match, না পেলে শুধু host+path
 * (tracking param যেমন ?utm_source=... থাকলেও যেন মেলে)।
 */
function findPageByUrl(pages, url) {
  if (!url) return null;

  const exact = normalizeUrl(url);
  let hit = pages.find((p) => normalizeUrl(p.url) === exact);
  if (hit) return hit;

  const pathOnly = normalizeUrl(url, { keepQuery: false });
  const matches = pages.filter(
    (p) => normalizeUrl(p.url, { keepQuery: false }) === pathOnly
  );

  return matches.length === 1 ? matches[0] : null;
}

/**
 * System prompt এ বসানোর জন্য site map:
 * - Title | URL | Description
 */
function buildSiteMap(pages, { limit = 120 } = {}) {
  const shown = pages.slice(0, limit);

  const lines = shown.map((p) => {
    const desc = p.description ? ` | ${p.description}` : "";
    return `- ${p.title} | ${p.url}${desc}`;
  });

  let text = lines.join("\n");

  if (pages.length > limit) {
    text +=
      `\n(This list shows only ${limit} of ${pages.length} pages. ` +
      `For other pages, call open_page with a "query" instead of a "url".)`;
  }

  return text;
}

// ------------------------------------------------------------
// Ranking
// ------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "show", "open", "page",
  "please", "want", "see", "get", "can", "you", "let", "view", "take",
  "link", "details", "detail", "about", "info", "information",
]);

function tokenize(s) {
  const raw = String(s || "").toLowerCase().match(/[\p{L}\p{M}\p{N}]{2,}/gu) || [];

  return Array.from(
    new Set(
      raw.filter((t) => {
        if (STOPWORDS.has(t)) return false;
        // ASCII শব্দ ৩+ অক্ষর (২ অক্ষরের ছোট শব্দ ভুল substring match করে)
        return /^[\x00-\x7f]+$/.test(t) ? t.length >= 3 : true;
      })
    )
  );
}

function urlWords(u) {
  const x = parseUrl(u);
  if (!x) return String(u || "").toLowerCase();

  let p = x.pathname + " " + x.search;
  try {
    p = decodeURIComponent(p);
  } catch (e) {
    // decode না হলে যেমন আছে তেমনই থাকুক
  }

  return p.toLowerCase().replace(/[-_/=&?.]+/g, " ");
}

const MIN_SCORE = 0.3;

/**
 * pages কে query এর সাথে মিলের ক্রমে সাজায়।
 *  - hits: vectorStore.search() এর ফলাফল ([{url, score, ...}])
 *  - score = সেরা chunk এর embedding similarity + title/url keyword match বোনাস
 * ফেরত: [{ url, title, score }] (সবচেয়ে ভালো আগে), মিল না থাকলে খালি array।
 */
function rankPages(pages, query, hits = []) {
  const embByUrl = new Map();

  for (const h of hits || []) {
    if (!h || !h.url) continue;
    const prev = embByUrl.get(h.url) || 0;
    if ((h.score || 0) > prev) embByUrl.set(h.url, h.score || 0);
  }

  const qTokens = tokenize(query);

  const scored = pages.map((p) => {
    const hay = `${p.title} ${urlWords(p.url)}`.toLowerCase();

    let matched = 0;
    for (const t of qTokens) {
      if (hay.includes(t)) matched++;
    }

    const lex = qTokens.length ? matched / qTokens.length : 0;
    const emb = embByUrl.get(p.url) || 0;

    return {
      url: p.url,
      title: p.title,
      score: emb + lex * 0.8,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < MIN_SCORE) return [];

  return scored.slice(0, 4).filter((s) => s.score >= MIN_SCORE);
}

module.exports = {
  normalizeUrl,
  sameUrl,
  getPages,
  findPageByUrl,
  buildSiteMap,
  rankPages,
};
