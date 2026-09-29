// server/scraper.js
//
// Robust website crawler for AI/RAG training.
//
// Supports:
// - Static HTML websites
// - JavaScript rendered websites
// - React / Next.js / Vue / Angular / SPA
// - Same-domain crawling
// - Meta description
// - Headings, paragraphs, lists, tables
// - Dynamic content rendered by browser
// - Sitemap discovery
// - Retry + timeout
//
// Note:
// Login-protected, CAPTCHA-protected, paywalled or blocked
// websites cannot be guaranteed to work.

const { chromium } = require("playwright");
const cheerio = require("cheerio");

// ওয়েবসাইটের সব পেজ (About, Contact, FAQ, Policy, Product ...) যেন পাওয়া যায়,
// তাই default বড় রাখা হয়েছে। /api/train এ maxPages / maxDepth দিয়ে বদলানো যায়।
const DEFAULT_MAX_PAGES = 100;
const MAX_PAGES_LIMIT = 500;
const DEFAULT_MAX_DEPTH = 4;

// একসাথে কয়টা ট্যাবে ক্রল হবে (বেশি দিলে সাইট ব্লক করতে পারে)
const CONCURRENCY = 3;

// ক্রল সর্বোচ্চ কত সেকেন্ড চলবে। সময় শেষ হলে যতগুলো পেজ পাওয়া গেছে তা-ই নিয়ে
// training চলবে (গুরুত্বপূর্ণ পেজ আগে ক্রল হয়, তাই About/Contact বাদ পড়ে না)।
const CRAWL_TIME_LIMIT_MS =
  (Number(process.env.CRAWL_MAX_SECONDS) || 240) * 1000;

const MAX_QUEUE = 5000;
const MAX_SITEMAP_FILES = 40;
const MAX_SITEMAP_URLS = 5000;

const PAGE_TIMEOUT = 30000;
const NAVIGATION_TIMEOUT = 30000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36 " +
  "VoiceAgentTrainer/1.0";


// ============================================================
// URL NORMALIZATION System
// ============================================================

function normalizeUrl(url) {
  try {
    const u = new URL(url);

    // Remove hash
    u.hash = "";

    // Remove common tracking parameters
    const trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "mc_cid",
      "mc_eid",
    ];

    for (const param of trackingParams) {
      u.searchParams.delete(param);
    }

    // Remove trailing slash except root
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }

    return u.toString();
  } catch {
    return null;
  }
}


// ============================================================
// CHECK WHETHER URL IS CRAWLABLE System
// ============================================================

function isValidHttpUrl(url) {
  try {
    const u = new URL(url);

    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      !!u.hostname
    );
  } catch {
    return false;
  }
}


// ============================================================
// SAME-SITE + CANONICAL URL System
// example.com আর www.example.com কে একই সাইট ধরা হয়, এবং সব URL কে
// শুরুর URL এর host এ নামিয়ে আনা হয় (যাতে widget সবসময় same-origin এ থাকে)।
// ============================================================

function bareHost(host) {
  return String(host || "").toLowerCase().replace(/^www\./, "");
}

function sameSite(hostA, hostB) {
  return bareHost(hostA) === bareHost(hostB);
}

function canonicalize(url, startObj) {
  try {
    const u = new URL(url);

    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!sameSite(u.hostname, startObj.hostname)) return null;

    u.protocol = startObj.protocol;
    u.host = startObj.host;

    return normalizeUrl(u.toString());
  } catch {
    return null;
  }
}


// ============================================================
// SKIP + PRIORITY System
// ============================================================

const SKIP_EXT =
  /\.(pdf|jpe?g|png|gif|webp|svg|ico|bmp|avif|mp3|mp4|mov|avi|webm|zip|rar|7z|gz|tar|exe|dmg|apk|css|js|json|xml|txt|rss|woff2?|ttf|eot|docx?|xlsx?|pptx?|csv)$/i;

const SKIP_SEGMENT =
  /^(cart|checkout|basket|login|log-in|signin|sign-in|logout|register|signup|sign-up|my-account|account|wp-admin|wp-login\.php|wp-json|feed|xmlrpc\.php|cdn-cgi|wishlist|compare|order-tracking)$/i;

const SKIP_QUERY =
  /(^|[?&])(add-to-cart|add_to_cart|orderby|sort|filter|min_price|max_price|replytocom|wc-ajax|share|print)(=|&|$)/i;

// কাজে লাগে না এমন URL (ছবি/ফাইল, cart, login, filter/sort ভ্যারিয়েন্ট) ক্রল করা হয় না
function shouldSkipUrl(url) {
  try {
    const u = new URL(url);

    if (SKIP_EXT.test(u.pathname)) return true;

    const segments = u.pathname.split("/").filter(Boolean);
    if (segments.some((seg) => SKIP_SEGMENT.test(seg))) return true;

    if (u.search && SKIP_QUERY.test(u.search)) return true;

    return false;
  } catch {
    return true;
  }
}

const INFO_SEGMENT =
  /(about|contact|faq|help|support|polic|privacy|terms|refund|return|shipping|delivery|warranty|pricing|price|plan|service|team|career|job|location|branch|store-locator|company|who-we-are|why-us|how-it-works|testimonial|review|gallery|portfolio|payment|track|feature|solution|partner|mission|vision|history|news-and-events|office|hours)/i;

const DEEP_SEGMENT =
  /^(product|products|item|items|sku|blog|blogs|news|post|posts|article|articles|tag|tags|author|archive|archives)$/i;

// কম সংখ্যা = আগে ক্রল হবে।
//  -1 = হোম পেজ,  0 = About/Contact/FAQ/Policy/Pricing ধরনের তথ্যের পেজ,
//   1 = অন্যান্য (category ইত্যাদি),  2 = আলাদা প্রোডাক্ট/ব্লগ পোস্ট (সংখ্যায় অনেক হয়)
function urlPriority(url, startUrl) {
  try {
    const u = new URL(url);

    if (normalizeUrl(url) === normalizeUrl(startUrl)) return -1;

    const segments = u.pathname.split("/").filter(Boolean);

    if (segments.length === 0) return -1;

    if (segments.some((seg) => INFO_SEGMENT.test(seg))) return 0;

    if (
      segments.some((seg) => DEEP_SEGMENT.test(seg)) ||
      /\/\d{4}\/\d{1,2}\//.test(u.pathname) ||
      segments.length >= 4
    ) {
      return 2;
    }

    return 1;
  } catch {
    return 1;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// ============================================================
// EXTRACT TEXT FROM HTML System
// ============================================================

function extractTextAndLinks(html, baseUrl) {
  const $ = cheerio.load(html);

  // ==========================================================
  // COLLECT LINKS System
  //
  // গুরুত্বপূর্ণ: লিংক আগে সংগ্রহ করা হয়, তারপর nav/header/footer মোছা হয়।
  // (আগে উল্টোটা ছিল — তাই About, Contact, FAQ এর মতো পেজের লিংক, যেগুলো
  //  সাধারণত menu / header / footer এ থাকে, কখনো খুঁজে পাওয়া যেত না।)
  // ==========================================================

  const base = new URL(baseUrl);
  const links = new Set();

  $("a[href], area[href]").each((_, el) => {
    const href = $(el).attr("href");

    if (!href) return;

    const h = href.trim();

    if (
      h.startsWith("#") ||
      /^(mailto:|tel:|javascript:|sms:|whatsapp:|data:)/i.test(h)
    ) {
      return;
    }

    try {
      const absoluteUrl = new URL(h, baseUrl);

      // Same site only (www / non-www একই ধরা হয়)
      if (
        sameSite(absoluteUrl.hostname, base.hostname) &&
        (absoluteUrl.protocol === "http:" ||
          absoluteUrl.protocol === "https:")
      ) {
        const normalized = normalizeUrl(absoluteUrl.toString());

        if (normalized) {
          links.add(normalized);
        }
      }
    } catch {
      // Ignore invalid URLs
    }
  });

  // পেজের প্রধান heading (একাধিক পেজের <title> এক হলে আলাদা করতে কাজে লাগে)
  const heading = $("h1")
    .first()
    .text()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  // Remove elements that normally don't contain useful
  // website knowledge.
  $(
    [
      "script",
      "style",
      "noscript",
      "svg",
      "canvas",
      "iframe",
      "template",
      "form",
      "button",
      "input",
      "select",
      "textarea",
      "nav",
      "footer",
      "header",
    ].join(",")
  ).remove();

  const title =
    $("title")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim() || "";

  const metaDescription =
    $('meta[name="description"]').attr("content") ||
    $('meta[property="og:description"]').attr("content") ||
    "";

  // Try to identify main content first.
  let root = $("main").first();

  if (!root.length) {
    root = $("article").first();
  }

  if (!root.length) {
    root = $('[role="main"]').first();
  }

  if (!root.length) {
    root = $("body");
  }

  // Collect meaningful blocks.
  const blocks = [];

  root
    .find(
      "h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote, pre, figcaption"
    )
    .each((_, el) => {
      const text = $(el)
        .text()
        .replace(/\s+/g, " ")
        .trim();

      if (text.length > 2) {
        blocks.push(text);
      }
    });

  let bodyText = blocks.join("\n");

  // If structured extraction produced too little text,
  // fall back to complete body text.
  if (bodyText.length < 100) {
    bodyText = root
      .text()
      .replace(/\s+/g, " ")
      .trim();
  }

  return {
    title,
    heading,
    metaDescription,
    bodyText,
    links: Array.from(links),
  };
}


// ============================================================
// WAIT FOR PAGE TO FINISH RENDERING System
// ============================================================

async function waitForPage(page) {
  try {
    await page.waitForLoadState("domcontentloaded", {
      timeout: PAGE_TIMEOUT,
    });
  } catch {
    // Continue even if timeout happens
  }

  // Give JavaScript applications some time to render.
  try {
    await page.waitForLoadState("networkidle", {
      timeout: 5000,
    });
  } catch {
    // Many modern websites never become completely idle.
  }

  // Small extra delay for client-side rendering.
  await page.waitForTimeout(1000);
}


// ============================================================
// FETCH ONE PAGE USING PLAYWRIGHT System
// ============================================================

async function fetchRenderedPage(page, url) {
  try {
    console.log(`[scraper] Opening: ${url}`);

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT,
    });

    if (!response) {
      console.log(`[scraper] No response: ${url}`);
      return null;
    }

    const status = response.status();

    console.log(`[scraper] HTTP ${status}: ${url}`);

    if (status >= 400) {
      console.log(`[scraper] HTTP error ${status}: ${url}`);
      return null;
    }

    await waitForPage(page);

    // Get the fully rendered HTML.
    const html = await page.content();

    if (!html || html.length < 100) {
      console.log(`[scraper] Empty HTML: ${url}`);
      return null;
    }

    // redirect হলে (যেমন /about → /about-us) শেষ URL টাই ব্যবহার হবে
    const finalUrl = page.url() || url;

    const result = extractTextAndLinks(html, finalUrl);

    result.finalUrl = finalUrl;

    console.log(
      `[scraper] Extracted ${result.bodyText.length} chars, ` +
        `${result.links.length} links: ${url}`
    );

    return result;
  } catch (error) {
    console.log(
      `[scraper] Failed: ${url} -> ${error.message}`
    );

    return null;
  }
}


// ============================================================
// SITEMAP DISCOVERY System
//
// robots.txt + /sitemap.xml + /sitemap_index.xml + /wp-sitemap.xml দেখা হয়।
// Sitemap index (যেটা অন্য sitemap এর তালিকা) হলে ভেতরের sitemap গুলোও
// পর্যন্ত খোলা হয় — Shopify / WordPress / WooCommerce সাইটে এটাই সব পেজের তালিকা।
// ============================================================

async function fetchText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/xml,text/xml,text/plain,*/*",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const text = await res.text();

    return text.length > 8_000_000 ? null : text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverSitemap(startUrl) {
  const start = new URL(startUrl);

  const seeds = new Set([
    `${start.origin}/sitemap.xml`,
    `${start.origin}/sitemap_index.xml`,
    `${start.origin}/wp-sitemap.xml`,
  ]);

  const robots = await fetchText(`${start.origin}/robots.txt`, 8000);

  if (robots) {
    for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
      seeds.add(m[1]);
    }
  }

  const stack = Array.from(seeds).map((url) => ({ url, depth: 0 }));
  const seenMaps = new Set();
  const found = new Set();

  let fetched = 0;

  while (stack.length > 0 && fetched < MAX_SITEMAP_FILES) {
    const { url, depth } = stack.shift();

    if (seenMaps.has(url) || /\.gz$/i.test(url)) continue;

    seenMaps.add(url);

    console.log(`[sitemap] Checking: ${url}`);

    const body = await fetchText(url);

    fetched++;

    if (!body) continue;

    const isIndex = /<sitemapindex/i.test(body);
    const isUrlset = /<urlset/i.test(body);

    if (!isIndex && !isUrlset) continue;

    const $ = cheerio.load(body, { xmlMode: true });

    $("loc").each((_, el) => {
      const loc = $(el).text().trim();

      if (!loc) return;

      if (isIndex) {
        if (depth < 3) stack.push({ url: loc, depth: depth + 1 });
      } else {
        found.add(loc);
      }
    });

    if (found.size >= MAX_SITEMAP_URLS) break;
  }

  console.log(`[sitemap] Found ${found.size} URLs`);

  return Array.from(found);
}


// ============================================================
// MAIN CRAWLER System
// ============================================================

async function crawlWebsite(startUrl, opts = {}) {
  const maxPages = Math.min(
    Number(opts.maxPages) || DEFAULT_MAX_PAGES,
    MAX_PAGES_LIMIT
  );

  const maxDepth =
    opts.maxDepth !== undefined && opts.maxDepth !== null
      ? Number(opts.maxDepth)
      : DEFAULT_MAX_DEPTH;

  const start = normalizeUrl(startUrl);

  if (!start || !isValidHttpUrl(start)) {
    throw new Error("Invalid start URL");
  }

  const startObj = new URL(start);

  console.log("======================================");
  console.log("🌐 Website crawler started");
  console.log(`URL: ${start}`);
  console.log(`Max pages: ${maxPages}`);
  console.log(`Max depth: ${maxDepth}`);
  console.log(`Time limit: ${CRAWL_TIME_LIMIT_MS / 1000}s`);
  console.log("======================================");

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
    });

    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: {
        width: 1366,
        height: 768,
      },
      locale: "en-US",
    });

    // ছবি/ভিডিও/ফন্ট লাগে না — না লোড করলে ক্রল অনেক দ্রুত হয়
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();

      if (type === "image" || type === "media" || type === "font") {
        return route.abort();
      }

      return route.continue();
    });

    // --------------------------------------------------------
    // Queue System (priority অনুযায়ী: গুরুত্বপূর্ণ পেজ আগে)
    // --------------------------------------------------------

    const queue = [];
    const queued = new Set();
    const visited = new Set();
    const pages = [];

    let seq = 0;
    let active = 0;

    function enqueue(url, depth) {
      const canon = canonicalize(url, startObj);

      if (!canon) return false;
      if (queued.has(canon)) return false;
      if (canon !== start && shouldSkipUrl(canon)) return false;
      if (queued.size >= MAX_QUEUE) return false;

      queued.add(canon);

      queue.push({
        url: canon,
        depth,
        priority: urlPriority(canon, start),
        seq: seq++,
      });

      return true;
    }

    function takeNext() {
      if (queue.length === 0) return null;

      let best = 0;

      for (let i = 1; i < queue.length; i++) {
        const a = queue[i];
        const b = queue[best];

        if (
          a.priority < b.priority ||
          (a.priority === b.priority && a.depth < b.depth) ||
          (a.priority === b.priority &&
            a.depth === b.depth &&
            a.seq < b.seq)
        ) {
          best = i;
        }
      }

      return queue.splice(best, 1)[0];
    }

    enqueue(start, 0);

    // --------------------------------------------------------
    // Discover sitemap System
    // --------------------------------------------------------

    const sitemapLinks = await discoverSitemap(start);

    let sitemapAdded = 0;

    for (const url of sitemapLinks) {
      if (enqueue(url, 1)) sitemapAdded++;
    }

    console.log(`[crawler] ${sitemapAdded} URLs added from sitemap`);

    // --------------------------------------------------------
    // Crawl System (CONCURRENCY টা ট্যাব একসাথে)
    // --------------------------------------------------------

    const deadline = Date.now() + CRAWL_TIME_LIMIT_MS;

    let timedOut = false;

    async function worker(tab, workerId) {
      while (true) {
        if (pages.length >= maxPages) return;

        if (Date.now() > deadline) {
          timedOut = true;
          return;
        }

        // maxPages এর বেশি পেজ যেন একসাথে না খোলা হয়
        if (pages.length + active >= maxPages) {
          if (active === 0) return;
          await sleep(150);
          continue;
        }

        const current = takeNext();

        if (!current) {
          // অন্য ট্যাব নতুন লিংক আনতে পারে, তাই একটু অপেক্ষা
          if (active === 0) return;
          await sleep(150);
          continue;
        }

        const { url, depth } = current;

        if (visited.has(url)) continue;

        visited.add(url);

        active++;

        try {
          console.log(
            `\n[crawler#${workerId}] ${pages.length + 1}/${maxPages} ` +
              `(depth ${depth}, priority ${current.priority}) ${url}`
          );

          const result = await fetchRenderedPage(tab, url);

          if (!result) continue;

          // redirect এর পর শেষ URL — অন্য সাইটে গেলে বাদ, আগে দেখা হলে বাদ
          const finalUrl = canonicalize(result.finalUrl || url, startObj);

          if (!finalUrl) {
            console.log(`⚠️ Redirected outside the site: ${url}`);
            continue;
          }

          if (finalUrl !== url) {
            if (visited.has(finalUrl)) {
              console.log(`↪️ Already visited (redirect): ${finalUrl}`);
              continue;
            }

            visited.add(finalUrl);
            queued.add(finalUrl);
          }

          // পেজে সামান্য লেখা থাকলেও রাখা হয় (Contact পেজ প্রায়ই ছোট) —
          // নইলে agent ওই পেজ খুলে দিতে পারত না।
          if (result.bodyText.length > 15 || result.title) {
            const finalText = [
              result.title ? `Title: ${result.title}` : "",
              result.metaDescription
                ? `Description: ${result.metaDescription}`
                : "",
              result.bodyText,
            ]
              .filter(Boolean)
              .join("\n");

            pages.push({
              url: finalUrl,
              title: result.title || result.heading || finalUrl,
              heading: result.heading || "",
              text: finalText,
            });

            console.log(
              `✅ Page saved: ${result.bodyText.length} chars, ` +
                `${result.links.length} links`
            );
          } else {
            console.log(`⚠️ Not enough text: ${url}`);
          }

          // ------------------------------------------------------
          // Discover more links System
          // ------------------------------------------------------

          if (depth < maxDepth) {
            for (const link of result.links) {
              if (visited.has(link)) continue;

              enqueue(link, depth + 1);
            }
          }
        } finally {
          active--;
        }
      }
    }

    const tabs = [];

    for (let i = 0; i < CONCURRENCY; i++) {
      const tab = await context.newPage();
      tab.setDefaultTimeout(PAGE_TIMEOUT);
      tabs.push(tab);
    }

    await Promise.all(tabs.map((tab, i) => worker(tab, i + 1)));

    if (timedOut) {
      console.log(
        `⏱️ Time limit reached — using the ${pages.length} pages crawled so far`
      );
    }

    // একাধিক পেজের <title> এক হলে (অনেক SPA তে হয়) heading/URL দিয়ে আলাদা করা হয়,
    // যাতে agent "About" আর "Contact" আলাদা করে চিনতে পারে।
    const titleCount = new Map();

    for (const p of pages) {
      titleCount.set(p.title, (titleCount.get(p.title) || 0) + 1);
    }

    for (const p of pages) {
      if (titleCount.get(p.title) > 1) {
        let label = p.heading;

        if (!label) {
          try {
            const last = new URL(p.url).pathname
              .split("/")
              .filter(Boolean)
              .pop();

            label = last
              ? decodeURIComponent(last).replace(/[-_]+/g, " ")
              : "Home";
          } catch {
            label = "";
          }
        }

        if (label && !p.title.includes(label)) {
          p.title = `${label} – ${p.title}`;
        }
      }
    }

    // Home পেজ সবার আগে, বাকি গুলো URL অনুযায়ী
    pages.sort((a, b) => {
      const pa = urlPriority(a.url, start);
      const pb = urlPriority(b.url, start);
      return pa - pb || a.url.localeCompare(b.url);
    });

    console.log("\n======================================");
    console.log(`✅ Crawling finished. Pages: ${pages.length}`);
    console.log("======================================");

    return {
      pages: pages.slice(0, maxPages),
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}


// ============================================================
// TEXT CHUNKING System for the existing module
// ============================================================

function chunkText(
  text,
  {
    chunkSize = 900,
    overlap = 150,
  } = {}
) {
  if (!text) return [];

  const clean = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const chunks = [];

  let start = 0;

  while (start < clean.length) {
    let end = Math.min(
      start + chunkSize,
      clean.length
    );

    // Try to end at a sentence/line boundary.
    if (end < clean.length) {
      const boundary = clean.lastIndexOf(
        "\n",
        end
      );

      if (
        boundary > start + chunkSize * 0.5
      ) {
        end = boundary;
      } else {
        const sentenceBoundary = Math.max(
          clean.lastIndexOf(". ", end),
          clean.lastIndexOf("। ", end),
          clean.lastIndexOf("? ", end),
          clean.lastIndexOf("! ", end)
        );

        if (
          sentenceBoundary >
          start + chunkSize * 0.5
        ) {
          end = sentenceBoundary + 1;
        }
      }
    }

    const chunk = clean
      .slice(start, end)
      .trim();

    if (chunk.length > 30) {
      chunks.push(chunk);
    }

    if (end >= clean.length) {
      break;
    }

    start = Math.max(
      end - overlap,
      start + 1
    );
  }

  return chunks;
}


// ============================================================
// EXPORT System for the module
// ============================================================

module.exports = {
  crawlWebsite,
  chunkText,
  normalizeUrl,
};