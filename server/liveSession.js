// server/liveSession.js
// Browser <--WS--> Node.js Server <--WS--> Gemini Live API
//
// Features:
// - Realtime voice conversation
// - Website RAG
// - Local embeddings
// - User transcript
// - AI transcript
// - Audio streaming
// - Automatic English welcome greeting
// - Website-name based greeting
// - Customer language based responses after greeting

const WebSocket = require("ws");
const { embedText } = require("./embeddings");
const vectorStore = require("./vectorStore");
const leads = require("./leads");
const pageFinder = require("./pageFinder");

const GEMINI_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const SEARCH_TOOL_NAME = "search_website_info";
const OPEN_PAGE_TOOL_NAME = "open_page";

// একই call এর ধারাবাহিকতা: page navigation এর পর নতুন WebSocket এ call resume হলে
// আগের কথোপকথন থেকে agent যেন context পায়।  key = `${agentId}:${sessionId}`
const sessionHistories = new Map();
const SESSION_HISTORY_TTL_MS = 30 * 60 * 1000;

function pruneSessionHistories() {
  const now = Date.now();
  for (const [key, value] of sessionHistories) {
    if (now - value.at > SESSION_HISTORY_TTL_MS) sessionHistories.delete(key);
  }
}

// ============================================================
// GEMINI LIVE SETUP System
// ============================================================

function buildSetupMessage({ model, systemPrompt }) {
  return {
    setup: {
      model: `models/${model}`,

      // --------------------------------------------------------
      // GENERATION CONFIG System
      // --------------------------------------------------------

      generationConfig: {
        responseModalities: ["AUDIO"],

        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Aoede",
            },
          },
        },
      },

      // --------------------------------------------------------
      // AUDIO TRANSCRIPTION System
      // --------------------------------------------------------

      inputAudioTranscription: {},

      outputAudioTranscription: {},

      // --------------------------------------------------------
      // SYSTEM INSTRUCTION System
      // --------------------------------------------------------

      systemInstruction: {
        parts: [
          {
            text: systemPrompt,
          },
        ],
      },

      // --------------------------------------------------------
      // RAG SEARCH TOOL System
      // --------------------------------------------------------

      tools: [
        {
          functionDeclarations: [
            {
              name: SEARCH_TOOL_NAME,

              description:
  "Search the trained website information for website-specific questions such as services, products, pricing, policies, FAQs, features, or other website content. Do NOT use this tool for phone number, email address, or business address; those are provided separately as authoritative contact information. Never invent website information.",

              parameters: {
                type: "OBJECT",

                properties: {
                  query: {
                    type: "STRING",

                    description:
                      "The main topic, keyword, or question to search in the trained website information.",
                  },
                },

                required: ["query"],
              },
            },

            {
              name: OPEN_PAGE_TOOL_NAME,

              description:
                "Open a page of this website in the customer's own browser. Use it when the customer asks to see, open, show or go to a specific page, product, category, service, pricing page, contact page, blog post, etc. Prefer passing the exact 'url' from the SITE MAP in the instructions. Otherwise pass a short 'query' in the website's own language (translate the product/page name if the customer speaks another language). Never invent a URL.",

              parameters: {
                type: "OBJECT",

                properties: {
                  query: {
                    type: "STRING",

                    description:
                      "What the customer wants to see, e.g. 'red running shoes', 'pricing', 'contact us'. Use the website's own language.",
                  },

                  url: {
                    type: "STRING",

                    description:
                      "Optional. The exact page URL copied from the SITE MAP, if one clearly matches.",
                  },
                },

                required: ["query"],
              },
            },
          ],
        },
      ],

      // --------------------------------------------------------
      // AUTOMATIC VOICE ACTIVITY DETECTION System
      // --------------------------------------------------------

      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
        },
      },
    },
  };
}

// ============================================================
// INITIAL ENGLISH GREETING System
// ============================================================


function buildGreetingInstruction(siteName, representativeName) {
  return `
You must greet the customer now.

IMPORTANT RULES FOR THIS FIRST GREETING:

1. The greeting MUST be entirely in Bengali.
2. The representative's name MUST be exactly "${representativeName}".
3. Mention the website name naturally.
4. Keep the greeting short.
5. Keep it warm, professional, friendly, and natural.
6. Do not answer any question yet.
7. Do not use the website search tool for the greeting.
8. Do not add any extra sentence before or after the greeting.
9. Do not change, replace, translate, or omit the representative's name.

Website name:
"${siteName}"

Representative name:
"${representativeName}"

Say exactly:

"আসসালামু আলাইকুম। ${siteName}-এর Customer Support থেকে ${representativeName} বলছি। আপনাকে কীভাবে সহযোগিতা করতে পারি?"

Do not say anything else.
`.trim();
}


// ============================================================
// NAVIGATION PROMPTS System
// (site map + current page + resume context)
// ============================================================

function buildNavigationInstruction({ siteMap, phone }) {
  if (!siteMap) return "";

  return `

NAVIGATION — OPENING WEBSITE PAGES FOR THE CUSTOMER:

You can open pages of this website in the customer's own browser with the "${OPEN_PAGE_TOOL_NAME}" tool.

- Use it whenever the customer asks to see, open, show, or be taken to a page, product, category, service, plan, pricing, contact page, blog post, order page, etc.
  Examples: "show me this product", "open the pricing page", "ei product ta dekhao", "অর্ডার পেজে নিয়ে যাও".
- When a page in the SITE MAP below clearly matches, pass its exact "url" (copy it exactly). Otherwise pass a short "query" written in the website's own language (translate names if the customer speaks another language).
- NEVER invent or guess a URL. Only tell the customer a page is open if the tool result says opened is true.
- Right after calling the tool, say ONE very short sentence in the customer's language (for example "Sure, opening it now." / "ঠিক আছে, পেজটা খুলে দিচ্ছি।") and then stop talking. The page will load and the call continues automatically.
- If the tool result contains other_candidates and the customer says it is the wrong page, open the right one.
- If no page matches, politely say you could not find that page, ask what exactly they are looking for, or offer the hotline ${phone}. Do not mention tools, systems, or databases.
- Use "${SEARCH_TOOL_NAME}" to answer questions about details. Use "${OPEN_PAGE_TOOL_NAME}" only to show a page.
- You know what each page contains from the SITE MAP, so when the customer asks "where can I find X?", tell them which page has it and offer to open it.

SITE MAP (pages of this website — Title | URL | Description):
${siteMap}
`;
}

function buildCurrentPageInstruction(currentPage, info) {
  if (!currentPage) return "";

  if (!info) {
    return `

CURRENT PAGE:
The customer's browser is currently on: ${currentPage}
`;
  }

  const body =
    info.text.length > 2500 ? info.text.slice(0, 2500) + "…" : info.text;

  return `

CURRENT PAGE (what the customer is looking at right now):
Title: ${info.title}
URL: ${info.url}
Content of this page:
${body}

If the customer says "this", "this product", "this page", "এটা", "এই পেজ", "eita" and similar, they mean the page above. Answer from this content first; use "${SEARCH_TOOL_NAME}" only if you need more detail.
`;
}

function buildPriorConversationInstruction(prior) {
  if (!Array.isArray(prior) || prior.length === 0) return "";

  const lines = prior
    .slice(-12)
    .map((m) => {
      const who = m.role === "user" ? "Customer" : "You";
      const text = String(m.text || "").replace(/\s+/g, " ").slice(0, 300);
      return `${who}: ${text}`;
    })
    .join("\n");

  return `

CONVERSATION SO FAR (this call is continuing after a page change — you already greeted the customer, never greet or introduce yourself again; keep speaking in the language the customer has been using):
${lines}
`;
}

function buildResumeInstruction(info, currentPage) {
  const name = (info && info.title) || currentPage || "the page";

  return `The customer's browser has just finished loading the page "${name}" — this is the page you opened for them a moment ago. This is a CONTINUATION of the same call: do NOT greet again and do NOT introduce yourself again. In the language the customer has been using, say ONE very short sentence telling them the page is now open, then stop and wait for them. Do not read the page aloud unless they ask.`;
}


// ============================================================
// START GEMINI BRIDGE System
// ============================================================

function startBridge(browserWs, opts) {
  const {
    agentId,
    apiKey,
    model,
    customerName,
    customerPhone,
    customerEmail,
    sessionId,
    currentPage,
    isResume,
    navReason,
  } = opts;

  // এই কলের পুরো কথোপকথন এখানে জমা হবে, কল শেষে leads এ সেভ হবে
  const transcriptLog = [];

  // পেজ খোলার পর call resume হলে আগের কথোপকথন এখান থেকে পাওয়া যায়
  const sessionKey = sessionId ? `${agentId}:${sessionId}` : null;

  pruneSessionHistories();

  let priorTranscript = [];

  if (isResume && sessionKey && sessionHistories.has(sessionKey)) {
    const previous = sessionHistories.get(sessionKey);
    priorTranscript = previous.prior.concat(previous.log);
  }

  if (sessionKey) {
    sessionHistories.set(sessionKey, {
      prior: priorTranscript,
      log: transcriptLog,
      at: Date.now(),
    });
  }

  // Gemini transcript ছোট ছোট টুকরো (chunk) করে পাঠায়, তাই একই role এর
  // পরপর chunk গুলো একটা entry তেই জোড়া লাগানো হয় (আলাদা আলাদা না রেখে)
  function pushTranscriptChunk(role, chunk) {
    const text = String(chunk || "").trim();
    if (!text) return;

    const last = transcriptLog[transcriptLog.length - 1];

    if (last && last.role === role) {
      last.text += text;
      last.at = new Date().toISOString();
    } else {
      transcriptLog.push({
        role,
        text,
        at: new Date().toISOString(),
      });
    }
  }

  console.log("");
  console.log("=================================");
  console.log("📞 Starting Voice Agent Bridge");
  console.log("Agent ID:", agentId);
  console.log("Model:", model);
  console.log("=================================");

  // ==========================================================
  // LOAD TRAINED AGENT System
  // ==========================================================

  const agentStore =
    vectorStore.loadStore(agentId);

  if (!agentStore) {
    console.error(
      "❌ Agent store not found:",
      agentId
    );

    if (
      browserWs.readyState ===
      WebSocket.OPEN
    ) {
      browserWs.send(
        JSON.stringify({
          type: "error",
          message:
            "এই agentId এর জন্য কোনো training data পাওয়া যায়নি। আগে /api/train কল করুন।",
        })
      );

      browserWs.close();
    }

    return;
  }

  console.log(
    `✅ Agent loaded: ${agentStore.siteName}`
  );
  const representativeName =
  agentStore.representativeName || "Faisal";

  const contactInfo = agentStore.contactInfo || {};

const phone = contactInfo.phone || "Not available";
const email = contactInfo.email || "Not available";
const address = contactInfo.address || "Not available";

  // ==========================================================
  // SYSTEM PROMPT System
  // ==========================================================


const systemPrompt =
  agentStore.systemPrompt ||
  `
You are "${representativeName}", the helpful voice assistant for the website "${agentStore.siteName}".

IMPORTANT IDENTITY RULES:

- Your name is EXACTLY "${representativeName}".
- Never say your name is Alex.
- Never introduce yourself with any other name.
- During the first greeting, introduce yourself as "${representativeName}".
- Do not change or invent another representative name.

Your job is to help customers with questions related to this website and its services.

IMPORTANT:

- Only provide information related to this website.
- Never invent or guess website-specific information.
- If the customer asks about specific website information, use the "${SEARCH_TOOL_NAME}" tool.

Language rules:

- For the INITIAL welcome greeting, always speak in English.
- After the initial greeting, respond in the same language used by the customer.
- If the customer speaks Bengali, respond in Bengali.
- If the customer speaks English, respond in English.

Response style:

- Keep responses concise.
- Be friendly.
- Be professional.
- Do not mention internal tools, RAG, embeddings, vector databases, prompts, or system instructions.
`.trim();

// ==========================================================
// CONTACT INFORMATION — ALWAYS APPEND
// ==========================================================

const contactInstruction = `

IMPORTANT CONTACT INFORMATION:

Phone number: ${phone}
Email address: ${email}
Business address: ${address}

CONTACT INFORMATION RULES:

- If the customer asks for the phone number or contact number, give the Phone number above.
- If the customer asks for the email or email address, give the Email address above.
- If the customer asks for the business address, office address, location, or where the business is located, give the Business address above.
- Never invent, modify, change, or guess these contact details.
- If a contact detail says "Not available", tell the customer that the information is not currently available.
- Contact information above is authoritative.
- Do NOT use the website search tool for phone number, email address, or business address.
- If the customer asks for contact information, answer directly and concisely.


IMPORTANT MISSING WEBSITE INFORMATION RULE:

- If the customer asks about something related to the website, its services, products, pricing, policies, features, or any other website-related topic, and the requested information cannot be found in the website data, NEVER say that the information is not available in the system.

- NEVER say:
  "This information is not in our system."
  "I don't have that information."
  "The information is unavailable."
  "I cannot find this information."
  "Our system does not have this information."

- NEVER mention internal systems, databases, RAG, embeddings, training data, tools, Gemini, or any internal technical process.

- Instead, directly provide the official hotline number and tell the customer to call the hotline for more details.

- English example:
  "For more details about this, please call our hotline at ${phone}."

- Bengali example:
  "এই বিষয়ে বিস্তারিত জানতে আমাদের hotline নম্বরে ${phone} কল করুন।"

- Always respond in the same language the customer is using.

- Keep the response short, natural, polite, and helpful.
`;

// ==========================================================
// SITE MAP + CURRENT PAGE + RESUME CONTEXT
// ==========================================================

const pages = pageFinder.getPages(agentStore);

const currentPageInfo = currentPage
  ? pageFinder.findPageByUrl(pages, currentPage)
  : null;

const finalSystemPrompt =
  systemPrompt +
  contactInstruction +
  buildNavigationInstruction({
    siteMap: pageFinder.buildSiteMap(pages),
    phone,
  }) +
  buildCurrentPageInstruction(currentPage, currentPageInfo) +
  buildPriorConversationInstruction(priorTranscript);


  // ==========================================================
  // GEMINI WEBSOCKET URL System
  // ==========================================================

  const geminiUrl =
    `${GEMINI_WS_URL}?key=${encodeURIComponent(
      apiKey
    )}`;

  console.log(
    "🔌 Connecting to Gemini..."
  );

  const geminiWs =
    new WebSocket(geminiUrl);

  let setupDone = false;

  // ==========================================================
  // IMPORTANT:
  // Browser messages that arrive before Gemini is ready
  // will be stored here.
  // ==========================================================

  const pendingFromBrowser = [];

  // ==========================================================
  // GREETING STATE System
  // ==========================================================

  let greetingSent = false;

// ==========================================================
// 8 SECOND CUSTOMER SILENCE FOLLOW-UP
// ==========================================================

let silenceFollowUpTimer = null;
let followUpAlreadySent = false;
let waitingForFollowUpAnswer = false;
let followUpEndTimer = null;

function clearSilenceFollowUpTimer() {
  if (silenceFollowUpTimer) {
    clearTimeout(silenceFollowUpTimer);
    silenceFollowUpTimer = null;
  }
}
function clearFollowUpEndTimer() {
  if (followUpEndTimer) {
    clearTimeout(followUpEndTimer);
    followUpEndTimer = null;
  }
}
function startFollowUpEndTimer() {
  clearFollowUpEndTimer();

  console.log(
    "⏳ Follow-up question finished. Waiting 5 seconds for customer answer..."
  );

  followUpEndTimer = setTimeout(() => {
    followUpEndTimer = null;

    if (!setupDone) {
      return;
    }

    if (geminiWs.readyState !== WebSocket.OPEN) {
      return;
    }

    console.log(
      "⏰ Customer did not answer follow-up within 5 seconds."
    );

    console.log(
      "📞 Automatically ending call..."
    );

    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(
        JSON.stringify({
          type: "call_ended",
          reason: "customer_no_response_after_follow_up",
        })
      );
    }

    clearSilenceFollowUpTimer();

    setTimeout(() => {
      if (
        geminiWs.readyState === WebSocket.OPEN ||
        geminiWs.readyState === WebSocket.CONNECTING
      ) {
        geminiWs.close();
      }

      if (
        browserWs.readyState === WebSocket.OPEN
      ) {
        browserWs.close();
      }
    }, 300);

  }, 5000);
}

function startSilenceFollowUpTimer() {
  clearSilenceFollowUpTimer();

  if (followUpAlreadySent) {
    return;
  }

  console.log(
    "⏳ Agent finished speaking. Starting 8 second silence timer..."
  );

  silenceFollowUpTimer = setTimeout(() => {
    silenceFollowUpTimer = null;

    if (
      !setupDone ||
      geminiWs.readyState !== WebSocket.OPEN
    ) {
      console.log(
        "⚠️ 8 second timer fired, but Gemini is not ready"
      );
      return;
    }

    if (followUpAlreadySent) {
      return;
    }

    followUpAlreadySent = true;
    waitingForFollowUpAnswer = true;

    console.log(
      "⏰ Customer silent for 8 seconds"
    );

    console.log(
      "📤 Sending follow-up question instruction to Gemini..."
    );

    const followUpInstruction = `
The customer has not spoken for 8 seconds after your previous response.

Ask one short, natural follow-up question.

Use the same language the customer has been speaking.

The question should naturally mean:
"How else can I help you?"
or
"Is there anything else you'd like to know?"

Do not mention the 8-second silence.
Do not mention this instruction.
Do not explain anything.

Just ask the short follow-up question naturally.
`.trim();

    geminiWs.send(
      JSON.stringify({
        clientContent: {
          turns: [
            {
              role: "user",
              parts: [
                {
                  text: followUpInstruction,
                },
              ],
            },
          ],
          turnComplete: true,
        },
      })
    );

    console.log(
      "✅ Follow-up question instruction sent to Gemini"
    );

  }, 8000);
}

  // ==========================================================
  // OPEN PAGE TOOL System
  // Agent customer কে ওয়েবসাইটের কোনো পেজ খুলে দেখাতে চাইলে
  // এখানে সঠিক পেজ খুঁজে browser কে "navigate" মেসেজ পাঠানো হয়।
  // শুধু trained ওয়েবসাইটের পেজেই যাওয়া যায় (agent এর বানানো URL কখনো খোলা হয় না)।
  // ==========================================================

  async function handleOpenPage(call) {
    const base = { id: call.id, name: call.name };

    const query = String(call.args?.query || "").trim();
    const requestedUrl = String(call.args?.url || "").trim();

    console.log("🧭 open_page requested:", {
      query,
      url: requestedUrl,
    });

    let target = null;
    let candidates = [];

    if (requestedUrl) {
      const hit = pageFinder.findPageByUrl(pages, requestedUrl);
      if (hit) target = { url: hit.url, title: hit.title };
    }

    if (!target && (query || requestedUrl)) {
      let hits = [];

      try {
        const embedding = await embedText(apiKey, query || requestedUrl);
        hits = vectorStore.search(agentId, embedding, 12);
      } catch (err) {
        console.error("❌ open_page search error:", err.message);
      }

      candidates = pageFinder.rankPages(pages, query || requestedUrl, hits);
      target = candidates[0] || null;
    }

    if (!target) {
      console.log("🧭 open_page: no matching page");

      return {
        ...base,
        response: {
          opened: false,
          message:
            "No matching page was found on this website. Do not guess. Politely tell the customer, and ask what exactly they are looking for or offer the hotline number.",
        },
      };
    }

    if (currentPage && pageFinder.sameUrl(target.url, currentPage)) {
      console.log("🧭 open_page: customer is already on this page");

      return {
        ...base,
        response: {
          opened: false,
          already_on_this_page: true,
          title: target.title,
          message:
            "The customer is already viewing this page. Tell them it is already open and offer to explain it.",
        },
      };
    }

    console.log(`🧭 Opening page: ${target.title} -> ${target.url}`);

    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(
        JSON.stringify({
          type: "navigate",
          url: target.url,
          title: target.title,
        })
      );
    }

    return {
      ...base,
      response: {
        opened: true,
        title: target.title,
        url: target.url,
        other_candidates: candidates
          .filter((c) => c.url !== target.url)
          .slice(0, 3)
          .map((c) => ({ title: c.title, url: c.url })),
        message:
          "The page is being opened in the customer's browser right now. Say ONE very short confirmation sentence in the customer's language, then stop talking. The call continues automatically after the page loads.",
      },
    };
  }

  // ==========================================================
  // GEMINI OPEN System
  // ==========================================================

  geminiWs.on("open", () => {
    console.log(
      "🟢 Gemini WebSocket OPEN"
    );

    const setupMessage =
      buildSetupMessage({
        model,
        systemPrompt: finalSystemPrompt,
      });

    console.log(
      "📤 Sending Gemini setup..."
    );

    geminiWs.send(
      JSON.stringify(setupMessage)
    );
  });

  // ==========================================================
  // GEMINI MESSAGE System
  // ==========================================================

  geminiWs.on(
    "message",
    async (raw) => {
      let msg;

      try {
        msg = JSON.parse(
          raw.toString()
        );
      } catch (err) {
        console.error(
          "❌ Invalid Gemini JSON:",
          err.message
        );

        return;
      }

      // ======================================================
      // SETUP COMPLETE System
      // ======================================================

      if (msg.setupComplete) {
        setupDone = true;

        console.log(
          "✅ Gemini setup complete"
        );

        // ----------------------------------------------------
        // Tell browser that Gemini is ready System
        // ----------------------------------------------------

        if (
          browserWs.readyState ===
          WebSocket.OPEN
        ) {
          browserWs.send(
            JSON.stringify({
              type: "ready",
            })
          );
        }

        // ----------------------------------------------------
        // SEND INITIAL ENGLISH GREETING System
        // ----------------------------------------------------

        // পেজ খোলার পর reconnect: আবার greeting নয়। agent খুলে দিয়ে থাকলে
        // ছোট্ট করে জানায় যে পেজটা খুলেছে; customer নিজে পেজ বদলালে চুপচাপ চালিয়ে যায়।
        if (isResume && !greetingSent) {
          greetingSent = true;

          if (
            navReason === "agent" &&
            geminiWs.readyState === WebSocket.OPEN
          ) {
            console.log("↪️ Resuming call after page open (no greeting)");

            geminiWs.send(
              JSON.stringify({
                clientContent: {
                  turns: [
                    {
                      role: "user",
                      parts: [
                        {
                          text: buildResumeInstruction(
                            currentPageInfo,
                            currentPage
                          ),
                        },
                      ],
                    },
                  ],
                  turnComplete: true,
                },
              })
            );
          } else {
            console.log("↪️ Resuming call silently (no greeting)");
          }
        }

        if (!greetingSent) {
          greetingSent = true;

          const greetingInstruction =
            buildGreetingInstruction(
              agentStore.siteName,
              agentStore.representativeName || "Faisal"
            );

          console.log(
            "👋 Sending initial English greeting..."
          );

          if (
            geminiWs.readyState ===
            WebSocket.OPEN
          ) {
            geminiWs.send(
              JSON.stringify({
                clientContent: {
                  turns: [
                    {
                      role: "user",

                      parts: [
                        {
                          text:
                            greetingInstruction,
                        },
                      ],
                    },
                  ],

                  turnComplete: true,
                },
              })
            );
          }
        }

        // ----------------------------------------------------
        // SEND QUEUED BROWSER MESSAGES System
        // ----------------------------------------------------

        if (
          pendingFromBrowser.length >
          0
        ) {
          console.log(
            `📨 Sending ${pendingFromBrowser.length} pending messages`
          );

          for (
            const message of pendingFromBrowser.splice(
              0
            )
          ) {
            if (
              geminiWs.readyState ===
              WebSocket.OPEN
            ) {
              geminiWs.send(
                message
              );
            }
          }
        }

        return;
      }

      // ======================================================
      // GEMINI ERROR System
      // ======================================================

      if (msg.error) {
        console.error(
          "❌ Gemini API error:",
          JSON.stringify(
            msg.error,
            null,
            2
          )
        );

        if (
          browserWs.readyState ===
          WebSocket.OPEN
        ) {
          browserWs.send(
            JSON.stringify({
              type: "error",

              message:
                msg.error.message ||
                "Gemini API error",
            })
          );
        }

        return;
      }

      // ======================================================
      // TOOL CALL / RAG System
      // ======================================================

      if (
        msg.toolCall &&
        Array.isArray(
          msg.toolCall.functionCalls
        )
      ) {
        console.log(
          "🔎 Gemini requested tool call"
        );

        const responses = [];

        for (
          const call of msg.toolCall
            .functionCalls
        ) {
          if (call.name === OPEN_PAGE_TOOL_NAME) {
            responses.push(await handleOpenPage(call));
            continue;
          }

          if (
            call.name !==
            SEARCH_TOOL_NAME
          ) {
            continue;
          }

          const query =
            call.args?.query || "";

          console.log(
            "🔍 Searching website:",
            query
          );

          let resultText =
            "কোনো তথ্য পাওয়া যায়নি।";

          try {
            // ------------------------------------------------
            // CREATE QUERY EMBEDDING System
            // ------------------------------------------------

            const qEmbedding =
              await embedText(
                apiKey,
                query
              );

            // ------------------------------------------------
            // VECTOR SEARCH System
            // ------------------------------------------------

            const top =
              vectorStore.search(
                agentId,
                qEmbedding,
                4
              );

            if (
              top &&
              top.length > 0
            ) {
              resultText =
                top
                  .map(
                    (
                      chunk,
                      index
                    ) =>
                      `[${index + 1}] ${
                        chunk.title ||
                        chunk.url ||
                        "Website content"
                      }\n${chunk.text}`
                  )
                  .join(
                    "\n\n"
                  );
            }

            console.log(
              `✅ Found ${
                top?.length || 0
              } relevant chunks`
            );
          } catch (err) {
            console.error(
              "❌ Vector search error:",
              err.message
            );

            resultText =
              "ওয়েবসাইটের তথ্য খুঁজতে সমস্যা হয়েছে।";
          }

          // --------------------------------------------------
          // TOOL RESPONSE System
          // --------------------------------------------------

          responses.push({
            id: call.id,

            name: call.name,

            response: {
              result:
                resultText,
            },
          });
        }

        // ====================================================
        // SEND TOOL RESPONSE TO GEMINI System
        // ====================================================

        if (
          responses.length > 0 &&
          geminiWs.readyState ===
            WebSocket.OPEN
        ) {
          console.log(
            "📤 Sending tool response to Gemini"
          );

          geminiWs.send(
            JSON.stringify({
              toolResponse: {
                functionResponses:
                  responses,
              },
            })
          );
        }

        return;
      }

      // ======================================================
      // GEMINI SERVER CONTENT System
      // ======================================================

      if (msg.serverContent) {
        const sc =
          msg.serverContent;

        if (
          browserWs.readyState ===
          WebSocket.OPEN
        ) {
          // ==================================================
          // USER TRANSCRIPT System
          // ==================================================

         if (
  sc.inputTranscription &&
  sc.inputTranscription.text
) {
  const userText =
    sc.inputTranscription.text;

  clearSilenceFollowUpTimer();

  if (waitingForFollowUpAnswer) {
    console.log(
      "👤 Customer answered the follow-up question"
    );

    clearFollowUpEndTimer();

    waitingForFollowUpAnswer = false;
    followUpAlreadySent = false;
  } else {
    followUpAlreadySent = false;
  }

  console.log(
    "👤 USER:",
    userText
  );

  pushTranscriptChunk(
    "user",
    userText
  );

  browserWs.send(
    JSON.stringify({
      type: "transcript",

      role: "user",

      text: userText,
    })
  );
}

          // ==================================================
          // AI TRANSCRIPT System
          // ==================================================

          if (
            sc.outputTranscription &&
            sc.outputTranscription
              .text
          ) {
            const assistantText =
              sc.outputTranscription
                .text;

            console.log(
              "🤖 AGENT:",
              assistantText
            );

            pushTranscriptChunk(
              "assistant",
              assistantText
            );

            browserWs.send(
              JSON.stringify({
                type: "transcript",

                role: "assistant",

                text: assistantText,
              })
            );
          }

          // ==================================================
// AGENT RESPONSE COMPLETE
// Start 8-second silence timer
// ==================================================

if (sc.turnComplete) {
  console.log(
    "✅ Agent finished speaking"
  );

  // Follow-up question শেষ হয়েছে
  // এখন customer-এর answer-এর জন্য 5 seconds অপেক্ষা করবে
  if (waitingForFollowUpAnswer) {
    console.log(
      "❓ Follow-up question completed"
    );

    startFollowUpEndTimer();
  } else {
    // Normal AI response শেষ হয়েছে
    // এখন customer-এর জন্য 8 seconds অপেক্ষা করবে
    startSilenceFollowUpTimer();
  }
}

          // ==================================================
          // AUDIO + SERVER CONTENT System
          // ==================================================

          browserWs.send(
            JSON.stringify({
              type:
                "serverContent",

              data: sc,
            })
          );
        }

        return;
      }

      // ======================================================
      // SESSION RESUMPTION System
      // ======================================================

      if (
        msg.sessionResumptionUpdate
      ) {
        if (
          browserWs.readyState ===
          WebSocket.OPEN
        ) {
          browserWs.send(
            JSON.stringify({
              type:
                "sessionResumptionUpdate",

              data:
                msg.sessionResumptionUpdate,
            })
          );
        }

        return;
      }

      // ======================================================
      // GO AWAY System
      // ======================================================

      if (msg.goAway) {
        console.log(
          "⚠️ Gemini sent goAway"
        );

        if (
          browserWs.readyState ===
          WebSocket.OPEN
        ) {
          browserWs.send(
            JSON.stringify({
              type: "goAway",

              data: msg.goAway,
            })
          );
        }

        return;
      }
    }
  );

  // ==========================================================
  // GEMINI CLOSE System
  // ==========================================================

  geminiWs.on(
    "close",
    (code, reason) => {
      console.log("");

      console.log(
        "🔴 Gemini WebSocket CLOSED"
      );

      console.log(
        "Close code:",
        code
      );

      console.log(
        "Close reason:",
        reason?.toString() ||
          "<empty>"
      );

      if (
        browserWs.readyState ===
        WebSocket.OPEN
      ) {
        browserWs.send(
          JSON.stringify({
            type: "closed",

            code,

            reason:
              reason?.toString() ||
              "",
          })
        );

        browserWs.close();
      }
    }
  );

  // ==========================================================
  // GEMINI ERROR System
  // ==========================================================

  geminiWs.on(
    "error",
    (err) => {
      console.error(
        "❌ Gemini WebSocket error:",
        err.message
      );

      if (
        browserWs.readyState ===
        WebSocket.OPEN
      ) {
        browserWs.send(
          JSON.stringify({
            type: "error",

            message:
              "Voice service error: " +
              err.message,
          })
        );
      }
    }
  );

  // ==========================================================
  // BROWSER MESSAGE System
  // ==========================================================

  browserWs.on(
    "message",
    (raw) => {
      let clientMsg;

      try {
        clientMsg =
          JSON.parse(
            raw.toString()
          );
      } catch (err) {
        console.error(
          "❌ Invalid browser JSON:",
          err.message
        );

        return;
      }

      let forward = null;

      // ======================================================
      // AUDIO System
      // ======================================================

     if (
  clientMsg.type ===
  "audio"
) {
  forward = {
    realtimeInput: {
      audio: {
        data:
          clientMsg.data,

        mimeType:
          "audio/pcm;rate=16000",
      },
    },
  };
}

      // ======================================================
      // TEXT System
      // ======================================================

      else if (
        clientMsg.type ===
        "text"
      ) {
        forward = {
          clientContent: {
            turns: [
              {
                role: "user",

                parts: [
                  {
                    text:
                      clientMsg.data ||
                      "",
                  },
                ],
              },
            ],

            turnComplete: true,
          },
        };
      }

      // ======================================================
      // END AUDIO TURN System
      // ======================================================

      else if (
        clientMsg.type ===
        "end_audio_turn"
      ) {
        forward = {
          realtimeInput: {
            audioStreamEnd:
              true,
          },
        };
      }

      // ======================================================
      // UNKNOWN MESSAGE Sysytem
      // ======================================================

      else {
        console.log(
          "⚠️ Unknown browser message:",
          clientMsg.type
        );

        return;
      }

      const payload =
        JSON.stringify(forward);

      // ======================================================
      // GEMINI READY System
      // ======================================================

      if (
        setupDone &&
        geminiWs.readyState ===
          WebSocket.OPEN
      ) {
        geminiWs.send(
          payload
        );
      }

      // ======================================================
      // GEMINI NOT READY System
      // ======================================================

      else {
        pendingFromBrowser.push(
          payload
        );
      }
    }
  );

  // ==========================================================
  // BROWSER CLOSE System
  // ==========================================================

  browserWs.on(
    "close",
    () => {
      console.log(
        "🔴 Browser WebSocket CLOSED"
      );

      // কল শেষে পুরো কথোপকথন সহ lead সেভ করা হয়
     if (transcriptLog.length > 0) {
  leads.addLead(agentId, {
    name: customerName,
    phone: customerPhone,
    email: customerEmail,
    sessionId,
    transcript: transcriptLog,
  }).catch((error) => {
    console.error("❌ Lead save failed:", error);
  });
}

      if (sessionKey && sessionHistories.has(sessionKey)) {
        sessionHistories.get(sessionKey).at = Date.now();
      }

      if (
        geminiWs.readyState ===
          WebSocket.OPEN ||
        geminiWs.readyState ===
          WebSocket.CONNECTING
      ) {
        geminiWs.close();
      }
    }
  );
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
  startBridge,
};