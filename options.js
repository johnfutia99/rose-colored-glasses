// Rose Colored Glasses — options page. User-added sites only.

const el = (id) => document.getElementById(id);

function setStatus(text) {
  el("status").textContent = text;
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

loadSites();
