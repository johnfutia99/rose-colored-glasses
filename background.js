// Rose Colored Glasses — background service worker.
// Receives a batch of headlines from content.js, returns rewrites.
//
// Path order per batch: local cache, then on-device (Task 2.3), then the
// owner's Cloudflare Worker proxy. No user key anywhere; the anonymous
// quota id and headline text are the only data that leave the browser.

const MODEL = "deepseek-v4-flash";

const WORKER_URL = "https://rcg-rewrite.rosecoloredglasses.workers.dev/rewrite";
const WORKER_TIMEOUT_MS = 30000;
const RETRY_BACKOFF_MS = 2000;

const CACHE_PREFIX = "cache:";
const CACHE_MAX_ENTRIES = 2000;

// Badge style is global; the count itself is set per tab. Runs on every
// worker start. Rose matches popup.css --rose.
chrome.action.setBadgeBackgroundColor({ color: "#d94f74" }).catch(() => {});
chrome.action.setBadgeTextColor({ color: "#ffffff" }).catch(() => {});

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

// Both rewrite paths keep the same JSON-array contract. On-device output
// marks unusable indexes null so the caller can send exactly those to the
// Worker; the Worker path does its own per-index fallback server-side.
function parseArrayOrNulls(text, expectedLength) {
  const clean = String(text).replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean); // throws on garbage; caller catches
  if (!Array.isArray(parsed)) throw new Error("Model did not return a JSON array.");
  const out = [];
  for (let i = 0; i < expectedLength; i++) {
    out.push(typeof parsed[i] === "string" && parsed[i].trim() ? parsed[i].trim() : null);
  }
  return out;
}

// --- Rewrite paths ----------------------------------------------------------

// Anonymous install id, used for the Worker's daily quota and nothing else.
// Created once and persisted. If storage is unreachable we hand out a
// throwaway id rather than fail the rewrite.
async function getQuotaId() {
  try {
    const { quotaId } = await chrome.storage.local.get("quotaId");
    if (typeof quotaId === "string" && quotaId) return quotaId;
  } catch (err) {
    // Fall through to a fresh id.
  }
  const id = crypto.randomUUID();
  try {
    await chrome.storage.local.set({ quotaId: id });
  } catch (err) {
    // Couldn't persist; the throwaway id still lets this batch through.
  }
  return id;
}

// --- On-device path (Chrome Prompt API / Gemini Nano) -----------------------
// Free, private, offline. Only used when the model is already downloaded and
// ready ("available"); we never trigger a download. Any failure means null:
// the caller falls through to the Worker, never the console.

const ON_DEVICE_RECHECK_MS = 5 * 60 * 1000;
const ON_DEVICE_TIMEOUT_MS = 30000;

let onDeviceCheck = { at: 0, available: false };

async function onDeviceAvailable() {
  if (typeof LanguageModel === "undefined") return false;
  const now = Date.now();
  if (now - onDeviceCheck.at < ON_DEVICE_RECHECK_MS) return onDeviceCheck.available;
  let available = false;
  try {
    available = (await LanguageModel.availability()) === "available";
  } catch (err) {
    available = false;
  }
  onDeviceCheck = { at: now, available };
  return available;
}

// Returns null when unavailable or the whole batch failed. Otherwise an
// array matching headlines, with null at indexes the model fumbled — the
// caller sends exactly those to the Worker.
async function rewriteOnDevice(headlines, settings) {
  if (!(await onDeviceAvailable())) return null;
  let session = null;
  try {
    const signal = AbortSignal.timeout(ON_DEVICE_TIMEOUT_MS);
    session = await LanguageModel.create({
      initialPrompts: [{ role: "system", content: buildSystemPrompt(settings) }],
      signal
    });
    const output = await session.prompt(JSON.stringify(headlines), { signal });
    return parseArrayOrNulls(output, headlines.length);
  } catch (err) {
    return null;
  } finally {
    if (session) {
      try {
        session.destroy();
      } catch (err) {
        // Already gone.
      }
    }
  }
}

// Remember which path produced the last fresh rewrites, for the Options
// page note. Write only on change to keep storage quiet.
async function notePath(path) {
  try {
    const { lastPath } = await chrome.storage.local.get("lastPath");
    if (lastPath !== path) await chrome.storage.local.set({ lastPath: path });
  } catch (err) {
    // Cosmetic only; never block a rewrite on it.
  }
}

// The owner's Cloudflare Worker proxy. Throws with popup-ready status text
// on every failure; the caller leaves the page untouched.
async function rewriteViaWorker(headlines, settings) {
  const id = await getQuotaId();
  const payload = {
    id,
    headlines,
    // The Worker validates settings against a whitelist; send exactly that
    // shape. Unknown humor values (stale storage) degrade to wholesome.
    settings: {
      sarcasm: Number(settings.sarcasm) || 0,
      humor: STYLE_NOTES[settings.humor] ? settings.humor : "wholesome",
      checkedOut: Boolean(settings.checkedOut)
    }
  };

  let res;
  try {
    res = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS)
    });
  } catch (err) {
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      const timeout = new Error("That took too long. Give it a minute and try again.");
      timeout.retryable = true;
      throw timeout;
    }
    throw new Error("Can't reach the rose tint server. Are you offline?");
  }

  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    // Non-JSON body; the status code decides the message below.
  }

  if (!res.ok) {
    const friendly = data && typeof data.error === "string" && data.error;
    if (res.status === 429) {
      const quota = new Error(friendly || "Out of rose tint for today. Back tomorrow.");
      quota.retryable = true;
      throw quota;
    }
    if (res.status === 503) {
      throw new Error(friendly || "The rose tint budget ran out for this month. It refills soon.");
    }
    throw new Error(friendly || "The rewrite server had a moment. Try again.");
  }

  if (!data || !Array.isArray(data.rewrites) || data.rewrites.length !== headlines.length) {
    throw new Error("The rewrite server had a moment. Try again.");
  }
  return data.rewrites.map((r, i) =>
    typeof r === "string" && r.trim() ? r.trim() : headlines[i]
  );
}

// One retry with backoff on transient failures (429, timeout), then give up
// quietly: the second error propagates with the same popup-ready message.
// Offline, spend cap, and malformed responses fail straight through — a
// retry can't fix those. The pending promise keeps the MV3 worker alive
// across the backoff.
async function rewriteViaWorkerWithRetry(headlines, settings) {
  try {
    return await rewriteViaWorker(headlines, settings);
  } catch (err) {
    if (!err || !err.retryable) throw err;
    const jitter = Math.floor(Math.random() * 500);
    await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS + jitter));
    return rewriteViaWorker(headlines, settings);
  }
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

// Serve hits from the cache, send only the misses out (on-device first,
// else the Worker), merge everything back into index order. Zero misses
// means zero network calls.
async function rewriteWithCache(headlines, settings) {
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
    const missHeadlines = missIndexes.map((i) => headlines[i]);

    // On-device first. It may cover the whole batch, some of it (null =
    // fumbled index), or none (null result); the Worker takes the remainder,
    // so only that remainder costs quota.
    let fresh = await rewriteOnDevice(missHeadlines, settings);
    const usedOnDevice = fresh !== null;
    if (!fresh) fresh = new Array(missHeadlines.length).fill(null);

    const workerSlots = [];
    fresh.forEach((r, j) => {
      if (r === null) workerSlots.push(j);
    });
    if (workerSlots.length > 0) {
      try {
        const workerRewrites = await rewriteViaWorkerWithRetry(
          workerSlots.map((j) => missHeadlines[j]),
          settings
        );
        workerSlots.forEach((j, k) => {
          fresh[j] = workerRewrites[k];
        });
      } catch (err) {
        // If on-device produced nothing, this is a real failure: surface it.
        // If it covered part of the batch (e.g. offline, Worker unreachable),
        // keep the good rewrites and leave the fumbled few as originals
        // rather than junking the whole page.
        if (workerSlots.length === missHeadlines.length) throw err;
        workerSlots.forEach((j) => {
          fresh[j] = missHeadlines[j];
        });
      }
    }
    notePath(usedOnDevice ? "on-device" : "cloud");

    const entries = {};
    const now = Date.now();
    missIndexes.forEach((originalIndex, j) => {
      const rewrite = fresh[j];
      results[originalIndex] = rewrite;
      // A rewrite equal to its original means the model dropped that index;
      // don't cache the fallback.
      if (rewrite !== headlines[originalIndex]) {
        entries[keys[originalIndex]] = { r: rewrite, t: now };
      }
    });
    await cachePut(entries);
  }

  return results.map((r, i) => r || headlines[i]);
}

// --- User-enabled sites (optional host permissions) -------------------------
// The install-time site list never widens. Users grant extra origins one at a
// time from the popup; we register content.js dynamically for each. Patterns
// persist in storage under userSites so updates can re-register (Chrome
// clears dynamic scripts on extension update).

const USER_SITE_PATTERN = /^https:\/\/[a-z0-9.-]+\/\*$/i;

function siteScriptId(pattern) {
  return "rcg-user-" + pattern.replace(/^https:\/\//i, "").replace(/\/\*$/, "");
}

async function isScriptRegistered(id) {
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    return scripts.length > 0;
  } catch (err) {
    return false;
  }
}

async function registerUserSite(pattern) {
  if (typeof pattern !== "string" || !USER_SITE_PATTERN.test(pattern)) {
    return { error: "That site address doesn't look right." };
  }
  try {
    const id = siteScriptId(pattern);
    if (!(await isScriptRegistered(id))) {
      await chrome.scripting.registerContentScripts([
        {
          id,
          matches: [pattern],
          js: ["content.js"],
          runAt: "document_idle",
          persistAcrossSessions: true
        }
      ]);
    }
    const { userSites } = await chrome.storage.local.get({ userSites: [] });
    if (!userSites.includes(pattern)) {
      userSites.push(pattern);
      await chrome.storage.local.set({ userSites });
    }
    return { ok: true };
  } catch (err) {
    return { error: "Could not enable this site. Try again." };
  }
}

async function unregisterUserSite(pattern) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [siteScriptId(pattern)] });
  } catch (err) {
    // Not registered (already cleared by an update). Keep going.
  }
  try {
    await chrome.permissions.remove({ origins: [pattern] });
  } catch (err) {
    // Permission already gone. Keep going.
  }
  try {
    const { userSites } = await chrome.storage.local.get({ userSites: [] });
    await chrome.storage.local.set({ userSites: userSites.filter((p) => p !== pattern) });
    return { ok: true };
  } catch (err) {
    return { error: "Could not update the site list. Try again." };
  }
}

// Re-register user sites after updates, and drop any whose permission the
// user revoked from Chrome's own extension settings.
async function resyncUserSites() {
  try {
    const { userSites } = await chrome.storage.local.get({ userSites: [] });
    if (!Array.isArray(userSites) || userSites.length === 0) return;
    const keep = [];
    for (const pattern of userSites) {
      let granted = false;
      try {
        granted = await chrome.permissions.contains({ origins: [pattern] });
      } catch (err) {
        granted = false;
      }
      if (!granted) continue;
      keep.push(pattern);
      const id = siteScriptId(pattern);
      if (!(await isScriptRegistered(id))) {
        try {
          await chrome.scripting.registerContentScripts([
            {
              id,
              matches: [pattern],
              js: ["content.js"],
              runAt: "document_idle",
              persistAcrossSessions: true
            }
          ]);
        } catch (err) {
          // One bad entry must not block the rest.
        }
      }
    }
    if (keep.length !== userSites.length) {
      await chrome.storage.local.set({ userSites: keep });
    }
  } catch (err) {
    // Storage unavailable; next startup retries.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  resyncUserSites();
  getQuotaId(); // mint the anonymous quota id on install/update
  // BYOK is gone; scrub any key an earlier version stored.
  chrome.storage.local.remove(["apiKey", "apiKeys"]).catch(() => {});
});

// The popup can die mid-enable: on macOS the permission dialog steals focus
// and Chrome closes the popup, killing its JS before it can register the
// script. The grant itself still lands, so finish the job from here.
chrome.permissions.onAdded.addListener((added) => {
  handleGrantedOrigins((added && added.origins) || []);
});

async function handleGrantedOrigins(origins) {
  for (const origin of origins) {
    if (!USER_SITE_PATTERN.test(origin)) continue; // wildcard or non-user grant
    const result = await registerUserSite(origin);
    if (!result || !result.ok) continue;
    // Inject into the tab the user is looking at so the first enable click
    // flips the page. Double injection is safe: content.js guards itself.
    try {
      const tabs = await chrome.tabs.query({ url: origin, active: true });
      for (const tab of tabs) {
        if (tab.id) {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"]
          });
        }
      }
    } catch (err) {
      // No matching active tab; the registered script covers the next load.
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SET_BADGE") {
    // Content script reporting its live swap count. Tab-scoped badge text
    // clears automatically when the tab navigates or closes. Only tabs may
    // set it; a count of 0 (restore) blanks the badge.
    if (sender.tab && sender.tab.id != null) {
      const count = Number(message.count) || 0;
      chrome.action
        .setBadgeText({ tabId: sender.tab.id, text: count > 0 ? String(count) : "" })
        .catch(() => {});
    }
    return false;
  }
  if (message.type === "REGISTER_SITE") {
    registerUserSite(message.pattern).then(sendResponse);
    return true;
  }
  if (message.type === "UNREGISTER_SITE") {
    unregisterUserSite(message.pattern).then(sendResponse);
    return true;
  }
  if (message.type === "GET_PATH_INFO") {
    (async () => {
      let lastPath = null;
      try {
        ({ lastPath = null } = await chrome.storage.local.get("lastPath"));
      } catch (err) {
        // Cosmetic; report availability alone.
      }
      sendResponse({ onDeviceAvailable: await onDeviceAvailable(), lastPath });
    })();
    return true;
  }
  return false;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "CALL_API") return;

  (async () => {
    try {
      const rewrites = await rewriteWithCache(message.headlines, message.settings || {});
      sendResponse({ rewrites });
    } catch (err) {
      sendResponse({ error: err.message || "Unknown error." });
    }
  })();

  return true; // keep the message channel open for the async response
});
