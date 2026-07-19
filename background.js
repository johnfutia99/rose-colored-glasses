// Rose Colored Glasses — background service worker.
// Receives a batch of headlines from content.js, calls DeepSeek, returns rewrites.

const API_URL = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-v4-flash";

const CACHE_PREFIX = "cache:";
const CACHE_MAX_ENTRIES = 2000;

const STYLE_NOTES = {
  wholesome: "Warm, earnest, golden-retriever energy.",
  dry: "Deadpan and understated. No exclamation points.",
  absurd: "Surreal leaps and unexpected imagery.",
  dad: "Puns and dad jokes wherever possible.",
  unhinged: "Unhinged optimism. Everything is somehow wonderful.",
  feet: "A narrator with a barely concealed passion for beautiful feet. Every story drifts, longingly, toward elegant arches, delicate ankles, bare soles on cool tile. Breathy reverence, wistful sighs, suggestive innuendo. Flirt with the line but never cross it: no explicit acts, nothing graphic. Admire feet in the abstract only, never the feet of named real people.",
  squirrels: "Retell every story as the misadventures of squirrels. The squirrels are ambitious, in over their heads, and doing their best.",
  shakespeare: "Triumphant Elizabethan proclamations. Hark, forsooth, much rejoicing.",
  infomercial: "Late-night infomercial pitchman. Every story is an incredible deal, and wait, there's more.",
  midwest: "Midwest nice. Everything is 'not too bad' and 'could be worse, honestly.' Ope."
};

function buildSystemPrompt(settings) {
  const sarcasm = Number(settings.sarcasm) || 0;
  const style = STYLE_NOTES[settings.humor] || STYLE_NOTES.wholesome;
  const facts = settings.checkedOut
    ? "Facts are optional. Drift as far from reality as needed for maximum bliss."
    : "Keep the core facts recognizable. Deliver the real information, just with levity and grace. Turn the edge and anger off.";
  return [
    "You rewrite news headlines into happier versions.",
    `Humor style: ${style}`,
    `Sarcasm level: ${sarcasm}/10. 0 means fully sincere. 10 means dripping, satirical-newspaper-grade sarcasm.`,
    facts,
    "Keep each rewrite under 140 characters.",
    "You will receive a JSON array of headlines.",
    "Return ONLY a JSON array of strings. Same length, same order. No commentary. No markdown fences."
  ].join(" ");
}

function parseArray(text, originals) {
  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);
  if (!Array.isArray(parsed)) throw new Error("Model did not return a JSON array.");
  return originals.map((original, i) =>
    typeof parsed[i] === "string" && parsed[i].trim() ? parsed[i].trim() : original
  );
}

// --- Rewrite cache ----------------------------------------------------------
// Keyed by SHA-256 of headline + model + the settings that shape the rewrite.
// Cache failures must never block a rewrite: every cache op degrades to a miss.

async function cacheKey(headline, settings) {
  const input = [
    headline,
    MODEL,
    Number(settings.sarcasm) || 0,
    settings.humor || "wholesome",
    Boolean(settings.checkedOut)
  ].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return CACHE_PREFIX + hex;
}

async function cacheGet(keys) {
  try {
    return await chrome.storage.local.get(keys);
  } catch (err) {
    return {};
  }
}

async function cachePut(entries) {
  if (Object.keys(entries).length === 0) return;
  try {
    await chrome.storage.local.set(entries);
    await pruneCache();
  } catch (err) {
    // Storage full or unavailable. The rewrite already went out; drop it.
  }
}

async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const entries = [];
  for (const key of Object.keys(all)) {
    if (key.startsWith(CACHE_PREFIX)) {
      entries.push([key, (all[key] && all[key].t) || 0]);
    }
  }
  if (entries.length <= CACHE_MAX_ENTRIES) return;
  entries.sort((a, b) => a[1] - b[1]); // oldest first
  const excess = entries.slice(0, entries.length - CACHE_MAX_ENTRIES).map((e) => e[0]);
  await chrome.storage.local.remove(excess);
}

// Serve hits from the cache, call the API for misses only, merge back into
// index order. Zero misses means zero network calls.
async function rewriteWithCache(headlines, settings, apiKey) {
  const keys = await Promise.all(headlines.map((h) => cacheKey(h, settings)));
  const cached = await cacheGet(keys);

  const results = new Array(headlines.length).fill(null);
  const missIndexes = [];
  headlines.forEach((headline, i) => {
    const entry = cached[keys[i]];
    if (entry && typeof entry.r === "string" && entry.r) {
      results[i] = entry.r;
    } else {
      missIndexes.push(i);
    }
  });

  if (missIndexes.length > 0) {
    const missTexts = missIndexes.map((i) => headlines[i]);
    const fresh = await callDeepSeek(missTexts, settings, apiKey);
    const toStore = {};
    const now = Date.now();
    missIndexes.forEach((originalIndex, j) => {
      results[originalIndex] = fresh[j];
      // Don't cache fallbacks where the model gave us nothing new, or a
      // headline would be stuck unflipped until the prune.
      if (fresh[j] && fresh[j] !== headlines[originalIndex]) {
        toStore[keys[originalIndex]] = { r: fresh[j], t: now };
      }
    });
    await cachePut(toStore);
  }

  return results.map((r, i) => r || headlines[i]);
}

function resolveApiKey(settings) {
  const keys = settings.apiKeys || {};
  // apiKeys.deepseek is the v0.2-0.3 slot; apiKey is the canonical field going forward.
  return keys.deepseek || settings.apiKey || "";
}

async function callDeepSeek(headlines, settings, apiKey) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      messages: [
        { role: "system", content: buildSystemPrompt(settings) },
        { role: "user", content: JSON.stringify(headlines) }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error((data && data.error && data.error.message) || `API error ${response.status}`);
  }

  const text =
    data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content || ""
      : "";
  return parseArray(text, headlines);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "CALL_API") return;

  (async () => {
    try {
      const settings = message.settings || {};
      const apiKey = resolveApiKey(settings);
      if (!apiKey) {
        sendResponse({ error: "No DeepSeek API key saved. Open the popup and paste one." });
        return;
      }
      const rewrites = await rewriteWithCache(message.headlines, settings, apiKey);
      sendResponse({ rewrites });
    } catch (err) {
      sendResponse({ error: err.message || "Unknown error." });
    }
  })();

  return true; // keep the message channel open for the async response
});
