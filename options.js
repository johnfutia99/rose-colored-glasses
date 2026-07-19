// Rose Colored Glasses — options page. Power-user settings only.

const el = (id) => document.getElementById(id);

function setStatus(text) {
  el("status").textContent = text;
}

async function loadKey() {
  try {
    const settings = await chrome.storage.local.get({ apiKey: "", apiKeys: {} });
    // Migrate the v0.2-0.3 per-provider key slot into the single field.
    el("apiKey").value = (settings.apiKeys && settings.apiKeys.deepseek) || settings.apiKey || "";
  } catch (err) {
    setStatus("Could not load settings. Try reopening this page.");
  }
}

async function saveKey() {
  try {
    await chrome.storage.local.set({
      apiKey: el("apiKey").value.trim(),
      apiKeys: {} // clear the old slot so there is one source of truth
    });
    setStatus(el("apiKey").value.trim() ? "Key saved." : "Key removed.");
  } catch (err) {
    setStatus("Could not save. Try again.");
  }
}

el("save").addEventListener("click", saveKey);
el("apiKey").addEventListener("change", saveKey);

loadKey();
