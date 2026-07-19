// Rose Colored Glasses — popup logic.

const DEFAULTS = {
  apiKey: "",
  apiKeys: {}, // v0.2-0.3 per-provider slot, migrated on load
  sarcasm: 3,
  humor: "wholesome",
  checkedOut: false,
  autoRewrite: true
};

const SARCASM_LABELS = [
  "Sincere sunshine", // 0
  "Sincere sunshine", // 1
  "Gently rosy",      // 2
  "Gently rosy",      // 3
  "Wry",              // 4
  "Wry",              // 5
  "Smirking",         // 6
  "Smirking",         // 7
  "Heavy eye-roll",   // 8
  "Heavy eye-roll",   // 9
  "The full Onion"    // 10
];

const el = (id) => document.getElementById(id);

function applyTint(value) {
  document.documentElement.style.setProperty("--sarc", String(value / 10));
  el("sarcasmLabel").textContent = SARCASM_LABELS[value];
}

function savedKey(settings) {
  return (settings.apiKeys && settings.apiKeys.deepseek) || settings.apiKey || "";
}

async function loadSettings() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  el("humor").value = settings.humor;
  el("sarcasm").value = settings.sarcasm;
  el("checkedOut").checked = settings.checkedOut;
  el("autoRewrite").checked = settings.autoRewrite;
  applyTint(Number(settings.sarcasm));
}

async function saveSettings() {
  // The API key lives in Options now; never write it from the popup.
  await chrome.storage.local.set({
    humor: el("humor").value,
    sarcasm: Number(el("sarcasm").value),
    checkedOut: el("checkedOut").checked,
    autoRewrite: el("autoRewrite").checked
  });
}

function setStatus(text) {
  el("status").textContent = text;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab.");
  return tab;
}

async function messageActiveTab(message) {
  const tab = await getActiveTab();
  return chrome.tabs.sendMessage(tab.id, message);
}

async function runRewrite() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  if (!savedKey(settings)) {
    setStatus("No API key saved. Right-click the icon and pick Options.");
    return;
  }
  setStatus("Rewriting...");
  try {
    const result = await messageActiveTab({ type: "REWRITE_NOW" });
    if (result && result.error) {
      setStatus(result.error);
    } else if (result) {
      setStatus(`Rewrote ${result.count} headlines.`);
    } else {
      setStatus("No response from the page.");
    }
  } catch (err) {
    setStatus("Open a supported news site first (AP, BBC, CNN, Google News...).");
  }
}

el("rewrite").addEventListener("click", async () => {
  await saveSettings();
  await runRewrite();
});

// --- "Enable on this site" ---------------------------------------------------
// Shown only when the active tab is an https page our content script isn't
// running on. One click: permission prompt, dynamic registration, inject,
// rewrite.

function sitePattern(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !url.hostname) return null;
    return `https://${url.hostname}/*`;
  } catch (err) {
    return null;
  }
}

async function detectUnsupportedSite() {
  try {
    const tab = await getActiveTab();
    if (!sitePattern(tab.url || "")) return; // chrome://, http, store pages
    await chrome.tabs.sendMessage(tab.id, { type: "PING" });
    // Ping answered: content script already runs here.
  } catch (err) {
    el("mainButtons").hidden = true;
    el("enableWrap").hidden = false;
  }
}

el("enableSite").addEventListener("click", async () => {
  let tab;
  try {
    tab = await getActiveTab();
  } catch (err) {
    setStatus("No active tab.");
    return;
  }
  const pattern = sitePattern(tab.url || "");
  if (!pattern) {
    setStatus("This page can't be enabled (https sites only).");
    return;
  }

  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [pattern] });
  } catch (err) {
    setStatus("Chrome refused that permission request.");
    return;
  }
  if (!granted) {
    setStatus("No permission granted. Nothing changed.");
    return;
  }

  const reg = await chrome.runtime.sendMessage({ type: "REGISTER_SITE", pattern });
  if (!reg || reg.error) {
    setStatus((reg && reg.error) || "Could not enable this site.");
    return;
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch (err) {
    setStatus("Enabled. Reload the page to see it work.");
    return;
  }

  el("enableWrap").hidden = true;
  el("mainButtons").hidden = false;
  await saveSettings();
  await runRewrite();
});

el("restore").addEventListener("click", async () => {
  try {
    const result = await messageActiveTab({ type: "RESTORE" });
    setStatus(`Restored ${result.count} headlines.`);
  } catch (err) {
    setStatus("Open a supported news site first.");
  }
});

el("sarcasm").addEventListener("input", (event) => {
  applyTint(Number(event.target.value));
});

// Save on any change so the auto-rewrite path always has fresh settings.
for (const id of ["humor", "sarcasm", "checkedOut", "autoRewrite"]) {
  el(id).addEventListener("change", saveSettings);
}

loadSettings();
detectUnsupportedSite();
