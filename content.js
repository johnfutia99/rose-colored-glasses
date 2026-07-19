// Rose Colored Glasses — content script.
// Finds headline-shaped text, sends it to the background worker, swaps it in place.

const MIN_LEN = 25;
const MAX_LEN = 180;
const MAX_HEADLINES = 40;

const DEFAULTS = {
  apiKey: "",
  apiKeys: {}, // v0.2-0.3 per-provider slot
  sarcasm: 3,
  humor: "wholesome",
  checkedOut: false,
  autoRewrite: true
};

function savedKey(settings) {
  return (settings.apiKeys && settings.apiKeys.deepseek) || settings.apiKey || "";
}

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

function collectHeadlines() {
  const candidates = document.querySelectorAll("h1, h2, h3, h4, a");
  const byText = new Map(); // text -> target element; innermost wins in document order

  for (const el of candidates) {
    if (el.closest("nav, footer")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const target = textTarget(el);
    const source = target.dataset.rcgOriginal || target.textContent || "";
    const text = source.trim().replace(/\s+/g, " ");
    if (text.length < MIN_LEN || text.length > MAX_LEN) continue;

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

function restore() {
  const swapped = document.querySelectorAll("[data-rcg-original]");
  let count = 0;
  for (const target of swapped) {
    target.textContent = target.dataset.rcgOriginal;
    delete target.dataset.rcgOriginal;
    count++;
  }
  return count;
}

async function rewritePage() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  if (!savedKey(settings)) {
    return { error: "No API key saved. Open the popup and paste one." };
  }

  const items = collectHeadlines();
  if (items.length === 0) {
    return { error: "No headlines found on this page." };
  }

  const response = await chrome.runtime.sendMessage({
    type: "CALL_API",
    headlines: items.map((item) => item.text),
    settings
  });

  if (!response || response.error) {
    return { error: (response && response.error) || "No response from background worker." };
  }

  let count = 0;
  response.rewrites.forEach((newText, i) => {
    if (newText && newText !== items[i].text) {
      swap(items[i].target, newText);
      count++;
    }
  });

  return { count };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "REWRITE_NOW") {
    rewritePage().then(sendResponse);
    return true;
  }
  if (message.type === "RESTORE") {
    sendResponse({ count: restore() });
    return false;
  }
});

// Auto-run on page load if a key is saved and auto-rewrite is on.
(async () => {
  const settings = await chrome.storage.local.get(DEFAULTS);
  if (savedKey(settings) && settings.autoRewrite) {
    // Give late-loading pages a beat to paint their headlines.
    setTimeout(() => rewritePage(), 1200);
  }
})();
