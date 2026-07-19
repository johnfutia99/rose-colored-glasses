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

async function loadSettings() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  // Migrate the v0.2-0.3 per-provider key slot into the single field.
  const key = (settings.apiKeys && settings.apiKeys.deepseek) || settings.apiKey || "";
  el("apiKey").value = key;
  el("humor").value = settings.humor;
  el("sarcasm").value = settings.sarcasm;
  el("checkedOut").checked = settings.checkedOut;
  el("autoRewrite").checked = settings.autoRewrite;
  applyTint(Number(settings.sarcasm));
}

async function saveSettings() {
  await chrome.storage.local.set({
    apiKey: el("apiKey").value.trim(),
    apiKeys: {}, // clear the old slot so there is one source of truth
    humor: el("humor").value,
    sarcasm: Number(el("sarcasm").value),
    checkedOut: el("checkedOut").checked,
    autoRewrite: el("autoRewrite").checked
  });
}

function setStatus(text) {
  el("status").textContent = text;
}

async function messageActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab.");
  return chrome.tabs.sendMessage(tab.id, message);
}

el("rewrite").addEventListener("click", async () => {
  await saveSettings();
  if (!el("apiKey").value.trim()) {
    setStatus("Paste a DeepSeek API key first.");
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
for (const id of ["apiKey", "humor", "sarcasm", "checkedOut", "autoRewrite"]) {
  el(id).addEventListener("change", saveSettings);
}

loadSettings();
