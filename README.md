# Rose Colored Glasses

A Chrome extension that rewrites news headlines into happier versions.

## Load it (2 minutes)

1. Unzip this folder.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top right toggle).
4. Click **Load unpacked** and pick this folder.
5. Click the extension icon. Paste a DeepSeek API key (dev builds only; the shipped version needs no key).
6. Get a key at https://platform.deepseek.com (5M free tokens on signup, no card).
7. Open apnews.com or news.google.com. Watch the headlines flip.

## Model

- DeepSeek V4 Flash only. About 1/15th of a cent per page of 40 headlines.
- End state (PLAN.md Phase 2): users need no key. On-device when supported, otherwise a capped Worker proxy.
- Prompt tuning: `DEEPSEEK_API_KEY=... node tools/compare.js squirrels`

## Controls

- **Humor style**: Wholesome, Dry, Absurd, Dad jokes, Unhinged optimism, Beautiful feet enjoyer, Squirrel misadventures, Shakespearean, Infomercial pitchman, Midwest nice.
- **Sarcasm slider**: 0 is sincere. 10 is The Onion. The popup tint deepens as you slide.
- **Fully checked out**: facts become optional.
- **Rewrite pages automatically**: on by default once a key is saved.
- **Restore originals**: puts every headline back.

## Supported sites

US: AP, Google News, CNN, NPR, Reuters, NYT, WaPo, Yahoo News, NBC, Fox, USA Today, ABC, CBS, CNBC, Bloomberg, WSJ, Politico, Axios, The Hill, LA Times, Time.
World: BBC, Guardian, Al Jazeera, Sky News, Independent, Telegraph, CBC, ABC Australia.
Texas: Texas Tribune, Houston Chronicle, Dallas Morning News, Express-News, Statesman.
Anything else: "Enable on this site" ships in PLAN.md Task 1.5. Until then, add a pattern in `manifest.json` under `content_scripts.matches`.

## Notes

- CLAUDE.md holds the project rules for Claude Code. PLAN.md is the full build plan, Phase 1 through launch.
- The key lives in `chrome.storage.local` on your machine. Fine for a prototype. Don't ship it this way.
- Rewrites run once per page load. Reload the page after changing settings, or hit "Rewrite this page".
