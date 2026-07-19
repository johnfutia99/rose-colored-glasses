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

// --- User-added sites --------------------------------------------------------

function siteLabel(pattern) {
  return pattern.replace(/^https:\/\//i, "").replace(/\/\*$/, "");
}

async function loadSites() {
  let userSites = [];
  try {
    ({ userSites } = await chrome.storage.local.get({ userSites: [] }));
  } catch (err) {
    setStatus("Could not load your added sites.");
    return;
  }

  const list = el("siteList");
  list.textContent = "";
  el("sitesEmpty").hidden = userSites.length > 0;

  for (const pattern of userSites) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = siteLabel(pattern);
    const remove = document.createElement("button");
    remove.className = "ghost";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      let result = null;
      try {
        result = await chrome.runtime.sendMessage({ type: "UNREGISTER_SITE", pattern });
      } catch (err) {
        // Background worker unavailable; fall through to the error status.
      }
      if (result && result.ok) {
        setStatus(`Removed ${siteLabel(pattern)}.`);
      } else {
        setStatus((result && result.error) || "Could not remove that site. Try again.");
        remove.disabled = false;
      }
      loadSites();
    });
    li.append(name, remove);
    list.append(li);
  }
}

el("save").addEventListener("click", saveKey);
el("apiKey").addEventListener("change", saveKey);

loadKey();
loadSites();
