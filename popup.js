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

async function messageActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab.");
  return chrome.tabs.sendMessage(tab.id, message);
}

el("rewrite").addEventListener("click", async () => {
  await saveSettings();
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
