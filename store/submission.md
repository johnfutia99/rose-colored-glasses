# Chrome Web Store submission — paste-ready answers

Version uploaded: 1.0.0. Zip: `rose-colored-glasses-1.0.0.zip` (repo root, gitignored).

## Developer account

- One-time $5 registration fee at https://chrome.google.com/webstore/devconsole — pay with your own card.
- Developer email shown publicly: jared@thenearsky.com (verify it in the dashboard).

## Store listing tab

- Name, short description, long description, category, language: copy from `store/listing.md`.
- Screenshots: upload the four `store/screenshot-*.png` (order 1-4).
- Small promo tile: `store/promo-tile-440x280.png`.

## Privacy tab

### Single purpose description

> Rose Colored Glasses rewrites the headlines on news sites the user visits into humorous, happier versions, in the user's chosen comedy style. All permissions exist solely to find headline text on supported news pages, send it for rewriting, and swap the rewritten text in place.

### Permission justifications

**storage**
> Stores the user's settings (humor style, sarcasm level, toggles), a local cache of past rewrites so repeat pages need no network call, the list of sites the user has explicitly enabled, and a random install ID used only to enforce a fair daily rewrite limit. No personal data is stored.

**activeTab**
> The popup's "Rewrite this page" and "Restore originals" buttons act on the page the user is currently viewing when the user clicks them.

**scripting**
> Used only for the optional "Enable on this site" feature: when the user explicitly grants a new site via chrome.permissions.request, the content script is registered for that origin at runtime with chrome.scripting.registerContentScripts. Without user action, no script is registered beyond the install-time news sites.

**Host permission justification** (one field covers the list)
> The install-time host list contains exactly (a) our rewrite server, `rcg-rewrite.rosecoloredglasses.workers.dev`, which proxies headline text to the AI model so no API key ships in the extension, and (b) named major news sites where the extension's single purpose — rewriting headlines — operates: AP News, Google News, BBC, CNN, NPR, Reuters, The New York Times, The Guardian, The Washington Post, Yahoo News (news.yahoo.com and its redirect target www.yahoo.com/news), NBC News, Fox News, USA Today, CBS News, CNBC, Bloomberg, The Wall Street Journal, Politico, Axios, The Hill, LA Times, Time, Al Jazeera, The Independent, The Telegraph, CBC, ABC Australia, Texas Tribune, Houston Chronicle, Dallas Morning News, Express-News, Austin American-Statesman, ABC News (abcnews.go.com and its redirect target abcnews.com), and Sky News. No wildcard-all pattern is requested at install time.

**optional_host_permissions (`https://*/*`)**
> Powers the user-initiated "Enable on this site" popup button. The permission for a specific origin is requested at click time via chrome.permissions.request, granted per site by the user, listed in the extension's options page, and revocable there at any time. It is never requested at install.

### Remote code

Answer: **No, I am not using remote code.**
> All executable code ships in the package. The extension calls our rewrite server as a data API (JSON in, JSON out); no code is fetched or evaluated.

### Data usage form

Check ONLY:
- **Website content** (headline text from news pages, sent to our server for rewriting).

Leave every other category unchecked (no personally identifiable info, no health, no financial, no authentication, no communications, no location, no web history, no user activity).

The random install ID is not tied to any identity; it exists to rate-limit and is not linkable to a person. If the reviewer form asks about "unique identifiers", the ID falls under app functionality (abuse prevention/rate limiting), used for nothing else.

Certify all three statements (they are all true):
- Data is **not** sold to third parties.
- Data is **not** used or transferred for purposes unrelated to the item's single purpose.
- Data is **not** used or transferred to determine creditworthiness or for lending.

Note on transfers: headline text is processed by service providers to deliver the feature (Cloudflare runs the proxy; DeepSeek runs the model). That is "app functionality" transfer, consistent with the certifications.

### Privacy policy URL

```
https://johnfutia99.github.io/rose-colored-glasses/privacy.html
```

## Distribution tab

- Visibility: Public.
- Regions: all regions.
- Pricing: free.

## After submit

- Review typically takes a few days; broad-ish host list may draw a manual review.
- If rejected (per PLAN.md): soften the "Beautiful feet enjoyer" style name first, disclosure wording second.
