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

const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_DEPTH = 2;

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
// EXTRACT TEXT FROM HTML System
// ============================================================

function extractTextAndLinks(html, baseUrl) {
  const $ = cheerio.load(html);

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

  // ==========================================================
  // COLLECT LINKS System
  // ==========================================================

  const base = new URL(baseUrl);
  const links = new Set();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");

    if (!href) return;

    if (
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:") ||
      href.startsWith("javascript:")
    ) {
      return;
    }

    try {
      const absoluteUrl = new URL(href, baseUrl);

      // Same domain only
      if (
        absoluteUrl.hostname === base.hostname &&
        (absoluteUrl.protocol === "http:" ||
          absoluteUrl.protocol === "https:")
      ) {
        const normalized = normalizeUrl(
          absoluteUrl.toString()
        );

        if (normalized) {
          links.add(normalized);
        }
      }
    } catch {
      // Ignore invalid URLs
    }
  });

  return {
    title,
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
      timeout: 8000,
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

    const result = extractTextAndLinks(html, url);

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
// ============================================================

async function discoverSitemap(page, startUrl) {
  const start = new URL(startUrl);

  const sitemapUrls = [
    `${start.origin}/sitemap.xml`,
    `${start.origin}/sitemap_index.xml`,
  ];

  const discovered = new Set();

  for (const sitemapUrl of sitemapUrls) {
    try {
      console.log(`[sitemap] Checking: ${sitemapUrl}`);

      const response = await page.goto(sitemapUrl, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });

      if (!response || response.status() >= 400) {
        continue;
      }

      const contentType =
        response.headers()["content-type"] || "";

      const body = await page.content();

      if (
        contentType.includes("xml") ||
        body.includes("<urlset") ||
        body.includes("<sitemapindex")
      ) {
        const $ = cheerio.load(body, {
          xmlMode: true,
        });

        $("loc").each((_, el) => {
          const loc = $(el).text().trim();

          if (!loc) return;

          const normalized = normalizeUrl(loc);

          if (!normalized) return;

          try {
            const u = new URL(normalized);

            if (u.hostname === start.hostname) {
              discovered.add(normalized);
            }
          } catch {
            // Ignore invalid URLs
          }
        });
      }
    } catch {
      // Sitemap is optional.
    }
  }

  console.log(
    `[sitemap] Found ${discovered.size} URLs`
  );

  return Array.from(discovered);
}


// ============================================================
// MAIN CRAWLER System
// ============================================================

async function crawlWebsite(startUrl, opts = {}) {
  const maxPages =
    Number(opts.maxPages) || DEFAULT_MAX_PAGES;

  const maxDepth =
    opts.maxDepth !== undefined
      ? Number(opts.maxDepth)
      : DEFAULT_MAX_DEPTH;

  const start = normalizeUrl(startUrl);

  if (!start || !isValidHttpUrl(start)) {
    throw new Error("Invalid start URL");
  }

  const startHost = new URL(start).hostname;

  console.log("======================================");
  console.log("🌐 Website crawler started");
  console.log(`URL: ${start}`);
  console.log(`Max pages: ${maxPages}`);
  console.log(`Max depth: ${maxDepth}`);
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

    const page = await context.newPage();

    page.setDefaultTimeout(PAGE_TIMEOUT);

    // --------------------------------------------------------
    // Queue System
    // --------------------------------------------------------

    const queue = [
      {
        url: start,
        depth: 0,
      },
    ];

    const queued = new Set([start]);
    const visited = new Set();

    const pages = [];

    // --------------------------------------------------------
    // Discover sitemap System
    // --------------------------------------------------------

    const sitemapLinks = await discoverSitemap(
      page,
      start
    );

    // Add sitemap URLs before normal crawling.
    for (const url of sitemapLinks) {
      if (queued.size >= maxPages * 3) break;

      if (!queued.has(url)) {
        queued.add(url);

        queue.push({
          url,
          depth: 1,
        });
      }
    }

    // --------------------------------------------------------
    // Crawl System
    // --------------------------------------------------------

    while (
      queue.length > 0 &&
      pages.length < maxPages
    ) {
      const current = queue.shift();

      if (!current) continue;

      const { url, depth } = current;

      if (visited.has(url)) {
        continue;
      }

      visited.add(url);

      // Same domain safety check.
      try {
        const currentHost = new URL(url).hostname;

        if (currentHost !== startHost) {
          continue;
        }
      } catch {
        continue;
      }

      console.log(
        `\n[crawler] ${pages.length + 1}/${maxPages}`
      );
      console.log(`[crawler] Depth: ${depth}`);
      console.log(`[crawler] URL: ${url}`);

      const result = await fetchRenderedPage(
        page,
        url
      );

      if (!result) {
        continue;
      }

      // ------------------------------------------------------
      // Save page if useful content exists System
      // ------------------------------------------------------

      if (result.bodyText.length > 40) {
        const finalText = [
          result.title
            ? `Title: ${result.title}`
            : "",
          result.metaDescription
            ? `Description: ${result.metaDescription}`
            : "",
          result.bodyText,
        ]
          .filter(Boolean)
          .join("\n");

        pages.push({
          url,
          title: result.title || url,
          text: finalText,
        });

        console.log(
          `✅ Page saved: ${result.bodyText.length} chars`
        );
      } else {
        console.log(
          `⚠️ Not enough text: ${url}`
        );
      }

      // ------------------------------------------------------
      // Discover more links System
      // ------------------------------------------------------

      if (depth < maxDepth) {
        for (const link of result.links) {
          if (visited.has(link)) continue;
          if (queued.has(link)) continue;

          if (queue.length >= maxPages * 3) {
            break;
          }

          try {
            const linkHost =
              new URL(link).hostname;

            if (linkHost !== startHost) {
              continue;
            }
          } catch {
            continue;
          }

          queued.add(link);

          queue.push({
            url: link,
            depth: depth + 1,
          });
        }
      }
    }

    console.log("\n======================================");
    console.log(
      `✅ Crawling finished. Pages: ${pages.length}`
    );
    console.log("======================================");

    return {
      pages,
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