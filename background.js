// Rose Colored Glasses — background service worker.
// Receives a batch of headlines from content.js, returns rewrites.
//
// Interim state after BYOK removal: no rewrite path is wired up until the
// Phase 2 Worker lands. Cache hits still serve; misses fail with a friendly
// message.

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

// Shared by every Phase 2 rewrite path (on-device and the Worker keep the
// same JSON-array contract). Unused this instant, deliberately kept.
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

// Serve hits from the cache, merge back into index order. Zero misses means
// zero network calls. Until the Phase 2 Worker exists there is nothing to
// call for misses, so any miss fails the batch with a friendly message.
async function rewriteWithCache(headlines, settings) {
  const keys = await Promise.all(headlines.map((h) => cacheKey(h, settings)));
  const cached = await cacheGet(keys);

  const results = new Array(headlines.length).fill(null);
  let misses = 0;
  headlines.forEach((headline, i) => {
    const entry = cached[keys[i]];
    if (entry && typeof entry.r === "string" && entry.r) {
      results[i] = entry.r;
    } else {
      misses++;
    }
  });

  if (misses > 0) {
    throw new Error("Fresh rewrites are resting until the next update. Soon.");
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
  if (message.type === "REGISTER_SITE") {
    registerUserSite(message.pattern).then(sendResponse);
    return true;
  }
  if (message.type === "UNREGISTER_SITE") {
    unregisterUserSite(message.pattern).then(sendResponse);
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
