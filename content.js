// Rose Colored Glasses — content script.
// Finds headline-shaped text, sends it to the background worker, swaps it in place.
//
// The whole script runs inside a guard: user-enabled sites can get this file
// twice (dynamic registration + a one-time executeScript on the enable click),
// and a second pass must not redeclare bindings or double-register listeners.

(() => {

if (window.__rcgLoaded) return;
window.__rcgLoaded = true;

const MIN_LEN = 25;
const MAX_LEN = 180;
const MAX_HEADLINES = 60;

// Rate limit: rewrite requests per tab per rolling window. Overflow is queued
// for the next window instead of dropped.
const RATE_LIMIT = 6;
const RATE_WINDOW_MS = 60 * 1000;

// Per-hostname overrides. When a site's markup defeats the generic heuristic,
// add one entry here: a selector for its real headline elements, plus an
// optional minLen when real titles run shorter than the generic floor.
// Everything not listed uses the generic h1-h4 + links heuristic.
const SITE_OVERRIDES = {
  "news.google.com": {
    // Article title links only — never section labels or "More" chrome.
    // Google rotates class names and dropped <article> wrappers, but every
    // story link routes through /read/; section chrome routes elsewhere
    // (/stories/, /topics/). Image-only /read/ links have no text and fall
    // to the length filter. Known title classes ride along as backup.
    selector: 'a[href*="/read/"], a.JtKRv, a.gPFEn, a.kEAYTc',
    minLen: 15
  }
};

const DEFAULTS = {
  sarcasm: 3,
  humor: "wholesome",
  checkedOut: false,
  autoRewrite: true
};

// Find the deepest element that actually holds the headline text,
// so we don't wipe out timestamps or images nested inside a link.
function textTarget(el) {
  if (el.childElementCount === 0) return el;
  let best = null;
  let bestLen = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.childElementCount === 0) {
      const len = (node.textContent || "").trim().length;
      if (len > bestLen) {
        best = node;
        bestLen = len;
      }
    }
  }
  const elLen = (el.textContent || "").trim().length;
  if (best && bestLen >= elLen * 0.6) return best;
  return el;
}

// newOnly: skip targets we've already swapped (data-rcg-original present),
// so observer-driven passes touch only fresh headlines.
function collectHeadlines(newOnly) {
  const override = SITE_OVERRIDES[location.hostname];
  let candidates = [];
  if (override) {
    // Override sites never fall back to the generic heuristic: on these
    // sites it flips section labels and chrome. Zero matches after a
    // redesign means zero rewrites — quiet — until the map entry is fixed.
    try {
      candidates = document.querySelectorAll(override.selector);
    } catch (err) {
      // Bad selector in the map is a bug, but never a broken page.
    }
  } else {
    candidates = document.querySelectorAll("h1, h2, h3, h4, a");
  }
  const minLen = (override && override.minLen) || MIN_LEN;

  const byText = new Map(); // text -> target element; innermost wins in document order

  for (const el of candidates) {
    if (el.closest("nav, footer")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const target = textTarget(el);
    if (newOnly && target.dataset.rcgOriginal) continue;
    const source = target.dataset.rcgOriginal || target.textContent || "";
    const text = source.trim().replace(/\s+/g, " ");
    if (text.length < minLen || text.length > MAX_LEN) continue;

    byText.set(text, target);
  }

  const items = [];
  for (const [text, target] of byText) {
    items.push({ text, target });
    if (items.length >= MAX_HEADLINES) break;
  }
  return items;
}

function swap(target, newText) {
  if (!target.dataset.rcgOriginal) {
    target.dataset.rcgOriginal = target.textContent;
  }
  target.style.transition = "opacity 0.25s ease";
  target.style.opacity = "0";
  setTimeout(() => {
    target.textContent = newText;
    target.style.opacity = "1";
  }, 250);
}

// Apply a batch of rewrites with the observer suspended, so our own DOM
// mutations don't retrigger it. swap() finishes its text write 250ms out.
function applySwaps(items, rewrites) {
  let count = 0;
  suspendObserver();
  try {
    rewrites.forEach((newText, i) => {
      if (typeof newText === "string" && newText && newText !== items[i].text) {
        swap(items[i].target, newText);
        count++;
      }
    });
  } finally {
    setTimeout(resumeObserver, 500);
  }
  return count;
}

// --- Rate limiter -----------------------------------------------------------

let requestTimes = [];
let queuedTimer = null;

function takeRateSlot() {
  const now = Date.now();
  requestTimes = requestTimes.filter((t) => now - t < RATE_WINDOW_MS);
  if (requestTimes.length >= RATE_LIMIT) return false;
  requestTimes.push(now);
  return true;
}

// Schedule one observer-style pass for when the rate window frees up.
function queueForNextWindow() {
  if (queuedTimer) return;
  const now = Date.now();
  const oldest = requestTimes[0] || now;
  const waitMs = Math.max(oldest + RATE_WINDOW_MS - now, 0) + 100;
  queuedTimer = setTimeout(() => {
    queuedTimer = null;
    rewriteNewHeadlines();
  }, waitMs);
}

// --- MutationObserver -------------------------------------------------------

let observer = null;
let observerWanted = false;
let suspendCount = 0;
let debounceTimer = null;

function observerCallback(mutations) {
  let sawNewElement = false;
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        sawNewElement = true;
        break;
      }
    }
    if (sawNewElement) break;
  }
  if (!sawNewElement) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(rewriteNewHeadlines, 1000);
}

function startObserver() {
  observerWanted = true;
  if (!observer) observer = new MutationObserver(observerCallback);
  if (suspendCount === 0 && document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

function stopObserver() {
  observerWanted = false;
  clearTimeout(debounceTimer);
  clearTimeout(queuedTimer);
  queuedTimer = null;
  if (observer) observer.disconnect();
}

function suspendObserver() {
  suspendCount++;
  if (observer) observer.disconnect();
}

function resumeObserver() {
  suspendCount = Math.max(0, suspendCount - 1);
  if (suspendCount === 0 && observerWanted && observer && document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

// Observer-driven pass: new headlines only, quiet on every failure. A broken
// feed here must never touch the console or the page.
async function rewriteNewHeadlines() {
  try {
    const settings = await chrome.storage.local.get(DEFAULTS);

    const items = collectHeadlines(true);
    if (items.length === 0) return;

    if (!takeRateSlot()) {
      queueForNextWindow();
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "CALL_API",
      headlines: items.map((item) => item.text),
      settings
    });

    if (!response || response.error || !Array.isArray(response.rewrites)) return;
    if (response.rewrites.length !== items.length) return;
    applySwaps(items, response.rewrites);
  } catch (err) {
    // Extension reloaded mid-flight or the page is unloading. Stay quiet.
  }
}

// --- Full rewrite (popup button / auto-run) ---------------------------------

async function rewritePage() {
  const settings = await chrome.storage.local.get(DEFAULTS);

  const items = collectHeadlines(false);
  if (items.length === 0) {
    // Still watch for late-loading content (SPA pages start empty).
    startObserver();
    return { error: "No headlines found on this page." };
  }

  if (!takeRateSlot()) {
    queueForNextWindow();
    return { error: "Rate limit: 6 rewrites a minute. Queued for the next window." };
  }

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "CALL_API",
      headlines: items.map((item) => item.text),
      settings
    });
  } catch (err) {
    return { error: "Could not reach the background worker. Try reloading the page." };
  }

  if (!response || response.error) {
    return { error: (response && response.error) || "No response from background worker." };
  }
  if (!Array.isArray(response.rewrites) || response.rewrites.length !== items.length) {
    return { error: "Model returned a malformed response. Page left untouched." };
  }

  const count = applySwaps(items, response.rewrites);
  startObserver();
  return { count };
}

function restore() {
  stopObserver();
  const swapped = document.querySelectorAll("[data-rcg-original]");
  let count = 0;
  for (const target of swapped) {
    target.textContent = target.dataset.rcgOriginal;
    delete target.dataset.rcgOriginal;
    count++;
  }
  return count;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING") {
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "REWRITE_NOW") {
    rewritePage().then(sendResponse);
    return true;
  }
  if (message.type === "RESTORE") {
    sendResponse({ count: restore() });
    return false;
  }
});

// Auto-run on page load if auto-rewrite is on.
(async () => {
  try {
    const settings = await chrome.storage.local.get(DEFAULTS);
    if (settings.autoRewrite) {
      // Give late-loading pages a beat to paint their headlines.
      setTimeout(() => {
        // Skip if something already rewrote this page (e.g. the popup's
        // enable-site flow ran a rewrite right before injecting us).
        if (!document.querySelector("[data-rcg-original]")) rewritePage();
      }, 1200);
    }
  } catch (err) {
    // Storage unavailable (extension reloading). Nothing to do.
  }
})();

})();
