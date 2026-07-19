# Rose Colored Glasses

Chrome extension (Manifest V3) that rewrites news headlines into happier versions using an LLM. This started as a race with friends. The race is won. This is now a production build headed for the Chrome Web Store. The bar: it works for strangers, fails quietly, and the rewrites are funny.

## Production bar

- Every task ships with its error handling. No "handle errors later" passes.
- API failures surface as popup status text. They never break the page or leave headlines half-swapped.
- Handle offline, timeouts, and malformed model output without console errors.
- Never log API keys, anywhere, ever.
- Headline text and the anonymous quota ID are the only data that leave the browser. Keep it that way.
- Release builds are console-quiet. Strip debug logging before tagging a version.

## Hard rules

- Vanilla JavaScript only. No bundler, no framework, no TypeScript, no npm dependencies in the extension itself. (The Worker in `worker/` may use wrangler; nothing else.)
- Manifest V3. All network calls happen in `background.js` (the service worker), never in the content script.
- Settings live in `chrome.storage.local`. Never introduce localStorage.
- Keep the popup fun. The rose tint tied to the sarcasm slider is the signature. Don't flatten it into a settings form.
- Do not widen `host_permissions` or `content_scripts.matches` to `<all_urls>`. Named sites only. Broad permissions slow Chrome Web Store review. User-granted expansion goes through `optional_host_permissions` plus runtime registration (PLAN Task 1.5), never through the install-time list.

## Decisions (confirmed by the owner)

- Users never need their own API key. The no-key experience is the product requirement.
- One model: `deepseek-v4-flash`. The Anthropic path was removed in v0.4.0; git history has it if ever needed.
- Rewrite path order: on-device (Chrome Prompt API / Gemini Nano) when the device supports it, otherwise BYOK if the user saved a key, otherwise the owner's Cloudflare Worker proxy. A saved key is an explicit opt-out of the Worker: BYOK traffic must never spend the owner's quota or money.
- BYOK (a DeepSeek key in the options page) survives as a power-user option only. It bypasses the Worker quota.
- Never embed any API key in the extension bundle. A published extension is a public zip.
- The Worker always ships with all three caps: daily per-install quota, payload limits, and a monthly spend cap at DeepSeek's dashboard.
- The privacy policy (Phase 4) must state: headline text is processed by DeepSeek's servers unless on-device mode is active, and an anonymous install ID is used for quota only.
- No billing and no user accounts until 1,000 installs.

## Architecture

- `manifest.json` — MV3 config, named news sites, host permissions for api.deepseek.com and the Worker URL.
- `background.js` — service worker. Path selection (on-device / Worker / BYOK), prompt builder, JSON-array contract, cache.
- `content.js` — finds headline-shaped text (h1-h4 plus links 25-180 chars), dedupes innermost-wins, swaps text in place. `textTarget()` finds the deepest text-bearing node so timestamps and images inside links survive.
- `popup.html/css/js` — the fun controls: humor style, sarcasm slider, checked-out and auto-rewrite toggles, rewrite/restore buttons.
- `worker/` — Cloudflare Worker proxy (Phase 2). Holds the DeepSeek key as a secret, KV rewrite cache, quotas.
- `tools/compare.js` — Node script, one humor style at sarcasm 2/6/10 on 20 fixed headlines, for prompt tuning.

## Invariants to preserve

- `data-rcg-original` on a swapped node is the source of truth. Re-rewrites and the cache must read the original, never the current (already rewritten) text.
- The model contract is: JSON array of strings in, JSON array of strings out, same length, same order. Every rewrite path (on-device, Worker, BYOK) shares `buildSystemPrompt()`. If you change the prompt, change `tools/compare.js` and the Worker to match.
- Rewrites are index-mapped. Any collection change must keep headline order stable between collect and swap.
- DeepSeek model name is `deepseek-v4-flash`. The legacy `deepseek-chat` alias is dead as of 2026-07-24.

## Testing loop

1. Edit files.
2. chrome://extensions → reload the extension.
3. Reload apnews.com (easy case) and news.google.com (hard case: nested anchors, SPA navigation).
4. Check the service worker console via the extension's "Inspect views" link for API errors.
5. For prompt changes, run `node tools/compare.js squirrels` before touching the extension.

## Roadmap

The whole build lives in PLAN.md: Phase 1 robustness, Phase 2 the no-key stack, Phase 3 production polish, Phase 4 store package, Phase 5 launch, Phase 6 gated growth.
