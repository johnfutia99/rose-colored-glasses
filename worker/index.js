// Rose Colored Glasses — Cloudflare Worker proxy.
//
// One route: POST /rewrite. Body: { id, headlines, settings }.
// The DeepSeek key lives in the Worker secret DEEPSEEK_API_KEY. It never
// appears in the extension, the repo, a response, or a log.
//
// Caps (all three, always):
//   - payload limits, enforced here (400)
//   - daily per-install quota, tracked in KV (429)
//   - monthly spend cap, set in DeepSeek's dashboard; the resulting API
//     refusal surfaces here as a friendly 503
//
// KEEP IN SYNC: STYLE_NOTES and buildSystemPrompt() are copies of the ones in
// background.js. Any prompt change lands in background.js, tools/compare.js,
// and this file in the same commit (CLAUDE.md invariant).

const MODEL = "deepseek-v4-flash";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

const MAX_HEADLINES = 60;
const MAX_HEADLINE_CHARS = 200;
const MAX_BODY_BYTES = 64 * 1024;

const DAILY_PAGE_QUOTA = 120;
const QUOTA_TTL_SECONDS = 2 * 24 * 60 * 60; // key covers one UTC day; TTL just clears old keys
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

const UPSTREAM_TIMEOUT_MS = 25000;

// DeepSeek generation time grows with batch size and content variety:
// 20 varied real headlines measured at ~19s, brushing the 25s upstream
// timeout; 60 in one call is far past it. Chunks of 10 run in parallel
// keep the worst real-content chunk near 9s with a wide margin, while
// staying one request and one quota page.
const DEEPSEEK_CHUNK_SIZE = 10;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETTINGS_KEYS = ["sarcasm", "humor", "checkedOut"];

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

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// --- Validation --------------------------------------------------------------
// Returns an error string, or null when the body is acceptable.

function validate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Send a JSON object.";
  }
  const allowedTop = ["id", "headlines", "settings"];
  for (const key of Object.keys(body)) {
    if (!allowedTop.includes(key)) return "Unexpected field in request.";
  }

  if (typeof body.id !== "string" || !UUID_RE.test(body.id)) {
    return "Missing or malformed install id.";
  }

  const headlines = body.headlines;
  if (!Array.isArray(headlines) || headlines.length < 1 || headlines.length > MAX_HEADLINES) {
    return `headlines must be an array of 1-${MAX_HEADLINES} strings.`;
  }
  for (const h of headlines) {
    if (typeof h !== "string") return "Every headline must be a string.";
    const len = h.trim().length;
    if (len < 1 || len > MAX_HEADLINE_CHARS) {
      return `Each headline must be 1-${MAX_HEADLINE_CHARS} characters.`;
    }
  }

  const settings = body.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return "settings must be an object.";
  }
  for (const key of Object.keys(settings)) {
    if (!SETTINGS_KEYS.includes(key)) return "Unexpected setting.";
  }
  if ("sarcasm" in settings) {
    const s = settings.sarcasm;
    if (typeof s !== "number" || !Number.isFinite(s) || s < 0 || s > 10) {
      return "sarcasm must be a number from 0 to 10.";
    }
  }
  if ("humor" in settings) {
    if (typeof settings.humor !== "string" || !(settings.humor in STYLE_NOTES)) {
      return "Unknown humor style.";
    }
  }
  if ("checkedOut" in settings && typeof settings.checkedOut !== "boolean") {
    return "checkedOut must be true or false.";
  }
  return null;
}

// --- Quota -------------------------------------------------------------------
// One valid POST = one page. Counted before any upstream work so pure
// cache-hit pages count too. KV writes aren't atomic; a near-limit race
// letting one extra page through is acceptable.

async function checkAndBumpQuota(env, id) {
  const day = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const key = `quota:${id}:${day}`;
  let count = 0;
  try {
    count = parseInt((await env.RCG_KV.get(key)) || "0", 10) || 0;
  } catch (err) {
    // KV read failed: fail open. A missed count beats a broken product.
  }
  if (count >= DAILY_PAGE_QUOTA) return false;
  try {
    await env.RCG_KV.put(key, String(count + 1), { expirationTtl: QUOTA_TTL_SECONDS });
  } catch (err) {
    // Same: fail open.
  }
  return true;
}

// --- Shared rewrite cache ----------------------------------------------------
// Same key recipe as cacheKey() in background.js, so one wording of a
// headline+settings hashes identically everywhere.

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
  return "cache:" + hex;
}

// --- DeepSeek ----------------------------------------------------------------

class UpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function callDeepSeek(env, headlines, settings) {
  let res;
  try {
    res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [
          { role: "system", content: buildSystemPrompt(settings) },
          { role: "user", content: JSON.stringify(headlines) }
        ]
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (err) {
    // Timeout or network failure reaching DeepSeek.
    throw new UpstreamError(502, "The rewrite engine is napping. Try again in a minute.");
  }

  if (res.status === 402) {
    // Monthly spend cap hit at DeepSeek's dashboard.
    throw new UpstreamError(503, "The rose tint budget ran out for this month. It refills soon.");
  }
  if (!res.ok) {
    throw new UpstreamError(502, "The rewrite engine is napping. Try again in a minute.");
  }

  let content;
  try {
    const data = await res.json();
    content = data.choices[0].message.content;
  } catch (err) {
    throw new UpstreamError(502, "The rewrite engine mumbled something unusable. Try again.");
  }

  let parsed;
  try {
    parsed = JSON.parse(content.replace(/```json|```/g, "").trim());
  } catch (err) {
    throw new UpstreamError(502, "The rewrite engine mumbled something unusable. Try again.");
  }
  if (!Array.isArray(parsed)) {
    throw new UpstreamError(502, "The rewrite engine mumbled something unusable. Try again.");
  }
  return parsed;
}

// One retry per chunk: the model occasionally returns broken JSON, and with
// several chunks per page an all-or-nothing pass would fail roughly half of
// full pages. Retrying only the broken chunk keeps that near zero for the
// cost of one extra small call. The spend-cap 503 never retries.
async function callDeepSeekWithRetry(env, headlines, settings) {
  try {
    return await callDeepSeek(env, headlines, settings);
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 503) throw err;
    return callDeepSeek(env, headlines, settings);
  }
}

// Split a big miss list into parallel DeepSeek calls so one full page never
// outruns the upstream timeout. Results merge back in index order. A chunk
// that fails twice fails the whole call with its friendly message — same
// all-or-nothing semantics as a single call.
async function callDeepSeekChunked(env, headlines, settings) {
  if (headlines.length <= DEEPSEEK_CHUNK_SIZE) {
    return callDeepSeekWithRetry(env, headlines, settings);
  }
  const chunks = [];
  for (let i = 0; i < headlines.length; i += DEEPSEEK_CHUNK_SIZE) {
    chunks.push(headlines.slice(i, i + DEEPSEEK_CHUNK_SIZE));
  }
  const results = await Promise.all(
    chunks.map((chunk) => callDeepSeekWithRetry(env, chunk, settings))
  );
  // Pin each chunk's result to its exact length so a short or long reply in
  // one chunk can't shift every index after it. Missing slots become null,
  // which the caller already treats as "model dropped this index".
  return results
    .map((arr, c) =>
      chunks[c].map((_, k) => (typeof arr[k] === "string" ? arr[k] : null))
    )
    .flat();
}

// --- Route -------------------------------------------------------------------

async function handleRewrite(request, env, ctx) {
  const lengthHeader = Number(request.headers.get("content-length"));
  if (lengthHeader > MAX_BODY_BYTES) {
    return json(400, { error: "That's too much news at once." });
  }

  let raw;
  try {
    raw = await request.text();
  } catch (err) {
    return json(400, { error: "Could not read the request." });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return json(400, { error: "That's too much news at once." });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    return json(400, { error: "Send valid JSON." });
  }

  const invalid = validate(body);
  if (invalid) return json(400, { error: invalid });

  if (!(await checkAndBumpQuota(env, body.id))) {
    return json(429, { error: "Out of rose tint for today. Back tomorrow." });
  }

  const headlines = body.headlines.map((h) => h.trim().replace(/\s+/g, " "));
  const settings = body.settings;

  // Shared cache lookups. Every cache failure degrades to a miss.
  const keys = await Promise.all(headlines.map((h) => cacheKey(h, settings)));
  const cached = await Promise.all(
    keys.map((key) => env.RCG_KV.get(key).catch(() => null))
  );

  const rewrites = new Array(headlines.length).fill(null);
  const missIndexes = [];
  headlines.forEach((_, i) => {
    if (typeof cached[i] === "string" && cached[i]) {
      rewrites[i] = cached[i];
    } else {
      missIndexes.push(i);
    }
  });

  if (missIndexes.length > 0) {
    const missHeadlines = missIndexes.map((i) => headlines[i]);
    let fresh;
    try {
      fresh = await callDeepSeekChunked(env, missHeadlines, settings);
    } catch (err) {
      const status = err instanceof UpstreamError ? err.status : 502;
      return json(status, { error: err.message || "Something went sideways. Try again." });
    }

    const cachePuts = [];
    missIndexes.forEach((originalIndex, j) => {
      const candidate = fresh[j];
      if (typeof candidate === "string" && candidate.trim()) {
        const rewrite = candidate.trim();
        rewrites[originalIndex] = rewrite;
        cachePuts.push(
          env.RCG_KV
            .put(keys[originalIndex], rewrite, { expirationTtl: CACHE_TTL_SECONDS })
            .catch(() => {})
        );
      } else {
        // Model dropped this index. Fall back to the original headline and
        // never write the fallback into the shared cache.
        rewrites[originalIndex] = headlines[originalIndex];
      }
    });
    ctx.waitUntil(Promise.all(cachePuts));
  }

  return json(200, { rewrites });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/rewrite") {
      return json(404, { error: "Nothing here. POST /rewrite is the only door." });
    }
    if (request.method !== "POST") {
      return json(405, { error: "POST only." });
    }
    try {
      return await handleRewrite(request, env, ctx);
    } catch (err) {
      // Last-resort net. No payloads, no key, no stack in the response.
      return json(500, { error: "Something went sideways. Try again." });
    }
  }
};
