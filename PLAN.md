# PLAN.md — prototype to Chrome Web Store, one plan

This is the whole build. Work the phases in order. In Claude Code, paste one phase at a time as its own session prompt. Commit after every task. CLAUDE.md holds the standing rules, the Production bar, and the confirmed decisions; they apply to every phase.

The product requirement that shapes everything: users never need their own API key.

---

## Phase 0: Baseline (already done, in this repo)

- DeepSeek-only. `deepseek-v4-flash` is the one model.
- Working MV3 extension: 14 news sites, 10 humor styles, sarcasm slider, checked-out toggle, restore button, auto-rewrite. Currently BYOK; that changes in Phase 2.
- `tools/compare.js` prints one humor style at sarcasm 2, 6, and 10 for prompt tuning.

Verify before Phase 1: load unpacked, paste a DeepSeek key, watch apnews.com flip.

---

## Phase 1: Robustness

### Task 1.1: MutationObserver
Infinite scroll and Google News SPA navigation currently escape the rewrite. Add a MutationObserver in content.js watching for added nodes, debounced to 1 second. Rewrite only new headlines; skip any text target that already has `data-rcg-original`. Disconnect the observer while swapping so our own mutations don't retrigger it. Raise MAX_HEADLINES to 60. Cap rewrite requests at 6 per minute per tab; queue overflow for the next window.

Acceptance: scroll news.google.com for 30 seconds. New headlines flip as they load. No loops, no double rewrites, quiet console.

### Task 1.2: Local rewrite cache
Add a cache in background.js. Key: SHA-256 of headline text + model + sarcasm + humor + checkedOut. Value: the rewrite. Store under a `cache:` prefix in chrome.storage.local. Send only cache misses; merge cached and fresh results back into index order. Prune oldest beyond 2,000 entries.

Acceptance: reload the same page twice. Second load makes zero network calls and flips instantly.

### Task 1.3: Options page
Add options.html/js registered in the manifest. Move the API key field there and label it "Power user: use your own DeepSeek key." The popup keeps the fun controls only. Options reuses popup.css variables.

Acceptance: key saves from Options, popup still rewrites, and the popup shows no key field.

### Task 1.4: Google News overrides
Add a per-hostname override map in content.js. news.google.com targets its article title elements directly; the generic heuristic stays as fallback for everything else. Adding a site is one map entry.

Acceptance: on news.google.com, article titles only. No rewritten section labels or "More" links.

### Task 1.5: "Enable on this site" (any site, user-granted)
Add `optional_host_permissions: ["https://*/*"]` to the manifest. When the popup opens on an unsupported site, show one button: "Enable on this site." Click: request the origin with chrome.permissions.request, register the content script dynamically with chrome.scripting.registerContentScripts, persist the origin in storage, run the rewrite. The Options page lists user-added sites with a remove control that also revokes the permission. The install-time warning must not change; optional permissions stay out of it.

Acceptance: visit an unlisted news site, click Enable, headlines flip. Remove the site in Options and it stops. The install warning still shows only the named sites.

---

## Phase 2: The no-key stack

This phase makes a fresh install work with zero setup.

### Task 2.1: Cloudflare Worker proxy (`worker/` directory)
- One route: POST /rewrite. Body: `{ id, headlines, settings }`.
- The DeepSeek key lives in a Worker secret. It never appears in the extension, the repo, or a response.
- Payload limits enforced server-side: max 60 headlines, each max 200 chars, settings whitelist only. Reject anything else with 400.
- KV rewrite cache, keyed by hash of headline + settings + model. Shared across all users: popular front pages cost one API call total.
- Daily quota: 30 pages per anonymous install ID, tracked in KV with a UTC daily reset. Over quota returns 429 with a friendly JSON message.
- Set a monthly spend cap in DeepSeek's dashboard. When the cap hits, the Worker returns 503 with a friendly message instead of failing silently.

Acceptance: curl the route with a valid payload and get rewrites; oversized payloads get 400; the 31st page for one ID gets 429.

### Task 2.2: Extension integration
- On install, generate `crypto.randomUUID()` once and store it as the quota ID. It is used for quota only.
- background.js path order per request: on-device if available, else the Worker. (BYOK was removed after v0.6.0; there is no key path.)
- Add the Worker URL to host_permissions.
- Quota and cap responses surface as popup status: "Out of rose tint for today. Back tomorrow."

Acceptance: a fresh profile with no key installed flips headlines immediately.

### Task 2.3: On-device mode (Chrome Prompt API / Gemini Nano)
- Feature-detect. If the model is available, use it: free, private, offline.
- Same prompt, same JSON-array contract, with per-headline fallback to the Worker when on-device output fails to parse.
- A one-line note in Options shows which path is active.

Acceptance: on supported hardware, airplane mode still flips headlines.

---

## Phase 3: Production polish

### Task 3.1: Badge counter
Count of rewritten headlines on the action icon per tab. Clear on navigation. Rose background, white text.

### Task 3.2: Failure behavior
Every failure leaves the page untouched and puts a human-readable reason in popup status: quota (429), spend cap (503), offline, timeout at 30 seconds, unparseable model output. One retry with backoff on 429 and timeouts, then give up quietly.

### Task 3.3: QA sweep
Every supported site, three settings combos, all three rewrite paths. Fix per-site breakage with override map entries, not heuristic changes. Strip every debug log. Record results in TESTING.md.

Acceptance for the phase: an afternoon of browsing produces zero console errors and zero broken layouts.

---

## Phase 4: Store package

### Task 4.1: Privacy policy
One static page on GitHub Pages. Plain language, short. It must state: headline text from pages you visit is sent to our server and processed by DeepSeek (servers in China) to produce rewrites, unless your device supports on-device mode, in which case nothing leaves your browser; a random install ID is used to enforce daily limits and identifies no one; nothing is sold, no analytics.

### Task 4.2: Listing assets
- 1280x800 screenshots: flipped pages in squirrel, Midwest nice, and Shakespearean modes, plus the popup at sarcasm 10.
- 440x280 promo tile from the icon art.
- Short description: "Reads the news through rose colored glasses. Every headline gets happier. You choose how sarcastic."
- Long description: what it does, the styles, no account and no key needed, link to the policy.

### Task 4.3: Submission
- $5 developer registration.
- Privacy practices form: single purpose (rewrites headline text on listed news sites); justify each permission (storage: settings and cache; activeTab: popup buttons; scripting: user-enabled sites; hosts: the news sites and the Worker).
- Upload, submit, expect a few days of review.

If rejected: the feet style is the first knob to soften, the disclosure wording is the second.

---

## Phase 5: Launch

- Record one GIF: squirrel mode, sarcasm 10, on a grim front page. That GIF is the marketing plan.
- Post: Product Hunt, r/InternetIsBeautiful, r/chrome_extensions, the group chat.
- README switches to the store link.
- Watch the DeepSeek dashboard daily for the first two weeks. The spend cap is the safety net, not the monitoring plan.

---

## Phase 6: Gated growth (tripwire: 1,000 installs)

Do none of this earlier.

- Payments (ExtensionPay or similar) only if the Worker bill actually hurts.
- Raise or tier quotas based on real usage data, not guesses.
- Firefox port if reviews ask for it.

---

## Standing prompt tuning loop

Any prompt change: edit `buildSystemPrompt` in background.js AND `tools/compare.js` AND the Worker, run `node tools/compare.js <style>`, read all three sarcasm levels out loud, then commit.
