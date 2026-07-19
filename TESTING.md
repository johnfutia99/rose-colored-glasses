# TESTING.md — Phase 3 QA sweep

Date: 2026-07-19. Extension version 0.7.0 (post Phase 3 tasks 3.1–3.3).
Worker deployed at sweep time: chunked DeepSeek calls (size 10, parallel), one
retry per failed chunk, daily quota 120 pages per install id.

## Settings combos

- **C1** wholesome / sarcasm 2 / checked-out off
- **C2** squirrels / sarcasm 6 / checked-out off
- **C3** midwest / sarcasm 10 / checked-out on

Matrix sites (all three combos): apnews.com, news.google.com, bbc.com,
nytimes.com. All other sites: C2. Auto-rewrite on throughout; driven in a
real Chrome profile via browser automation, swap counts read from
`[data-rcg-original]`.

## Rewrite path coverage

| Path | Status |
|---|---|
| Cloudflare Worker (cloud) | Exercised on every site below. |
| Local cache | Verified: repeat loads swap instantly with zero network calls; KV shared cache verified by curl (fresh batch ~10-17s, repeat 0.5s). |
| On-device (Gemini Nano) | **Not reachable on this machine** — Options reports "Rewrites go through our server". Untested here; per-headline fallback logic unchanged since Phase 2. |

## Per-site results

Counts are swapped headlines at ~18s after load (observer keeps adding on
long pages, so counts are floors, not totals).

| Site | Combo | Swaps | Notes |
|---|---|---|---|
| apnews.com | C1/C2/C3 | 60/60/60 | Clean. |
| news.google.com | C1/C2/C3 | 60/40/40 | Article titles only (override works). Site-own splash JS exception, present without swaps. |
| bbc.com | C1/C2/C3 | 54/53/55 | Rewrites the "British Broadcasting Corporation" logo link (cosmetic, see below). |
| nytimes.com | C1/C2/C3 | 118/37/41 | Observer adds late batches (118 after ~35s on C1). Site-own Statsig/FedCM/datadog errors. Rewrites photo credits + "Got a Tip?" promo (cosmetic, see below). |
| cnn.com | C2 | 60 | Clean. |
| npr.org | C2 | 60 | Clean. |
| reuters.com | C2 | 60 | Clean. |
| theguardian.com | C2 | 60 | Site-own commercial-JS AbortError. |
| washingtonpost.com | C2 | 60 | Clean. |
| yahoo news | C3 | 66 | Works on www.yahoo.com/news (host added to manifest). Hop from news.yahoo.com redirect is flaky — script sometimes misses the client-side redirect; direct/bookmarked www.yahoo.com/news is reliable. |
| nbcnews.com | C2 | 60 | Clean. |
| foxnews.com | C2 | 57 | Clean. |
| usatoday.com | C2 | 40 | Site-own ad-script TypeError. |
| cbsnews.com | C2 | 53 | Site-own video-embed FMS errors. |
| cnbc.com | C2 | 79 | First load hit a pre-fix Worker 502; clean after chunk-retry deploy. |
| bloomberg.com | C2 | 60 | No bot-wall trouble in a signed-in profile. |
| wsj.com | C2 | 60 | Front page swaps fine despite paywall. |
| politico.com | C2 | 56 | Clean. |
| axios.com | C2 | 14 | React #418/#423 hydration errors are **site-own**: reproduced with auto-rewrite off and zero swaps. Low count = Axios' short teaser markup; page intact. |
| thehill.com | C2 | 60 | Clean. |
| latimes.com | C2 | 60 | Clean. |
| time.com | C2 | 49 | Clean. |
| aljazeera.com | C2 | 60 | Site-own GPT ad exception. |
| independent.co.uk | C2 | 100 | Clean (second visit; first hit a pre-fix Worker 502). |
| telegraph.co.uk | C2 | 100 | Redirects to /us/, same host, works. |
| cbc.ca | C2 | 55 | Site-own BlueConic/sentry error. |
| abc.net.au | C2 | 60 | Rewrites "Skip to navigation" a11y links (cosmetic, see below). |
| texastribune.org | C2 | 29 | Clean. |
| houstonchronicle.com | C2 | 45 | Clean. |
| dallasnews.com | C2 | 58 | Site-own PerimeterX + ad-script errors. |
| expressnews.com | C2 | 52 | Clean. |
| statesman.com | C2 | 58 | Site-own PerimeterX error. |
| abcnews (go.com → abcnews.com) | C3 | 60 | Redirect host added to manifest; works. |
| news.sky.com | C2 | 60 | Clean. |

**Extension console errors across all sites: zero.** Every error above traced
to the site's own scripts (ads, analytics, video embeds, hydration), and the
axios case was explicitly verified with the extension inert.

## Issues found and fixed during the sweep

1. **Full pages 502ing**: one 60-headline DeepSeek call takes >25s (upstream
   timeout). Fixed: Worker splits misses into parallel chunks of 10
   (measured: 20 varied real headlines ≈ 18.6s, 60 ≈ untenable; chunked
   full page ≈ 10-17s).
2. **Intermittent "mumbled" 502s**: model occasionally returns broken JSON
   for a chunk; six chunks per page compounded to roughly half of cache-cold
   pages failing. Fixed: one retry per failed chunk (spend-cap 503 never
   retries). Post-fix probes: 3/3 clean with varied content.
3. **Dead manifest entries**: news.yahoo.com and abcnews.go.com now redirect
   off-manifest. Fixed: added `www.yahoo.com/news*`, `abcnews.com`,
   `*.abcnews.com` to `content_scripts.matches` (old entries kept).
4. Daily quota raised 30 → 120 pages per install id (owner decision).

## Known cosmetic wrong-element rewrites (deferred, no layout breakage)

Candidates for future `SITE_OVERRIDES` entries if they grate:

- nytimes.com: photo credit lines ("… for The New York Times") and the
  "Got a Tip?" promo get rewritten.
- bbc.com: the "British Broadcasting Corporation" logo link gets rewritten.
- abc.net.au: "Skip to navigation" accessibility links get rewritten.

Note: `SITE_OVERRIDES` replaces the generic heuristic wholesale for a site
(no fallback), so each needs a curated selector list; the generic heuristic
otherwise performs well on these sites. Deferred by choice, not oversight.

## Other notes

- Badge counter (Task 3.1) owner-verified on apnews: rose badge, white count,
  per-tab, clears on navigation and on Restore.
- Failure behavior (Task 3.2) owner-verified: offline message immediate (no
  retry), page untouched; 429/timeout retry once with ~2s backoff.
- One transient DeepSeek "napping" (502) observed during early testing
  resolved on retry; friendly popup message shown, page untouched, console
  quiet — as designed.
- Debug logging: `grep console.` across extension and Worker → zero hits.
