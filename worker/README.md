# Rose Colored Glasses — Worker proxy

Cloudflare Worker that holds the DeepSeek key so the extension never needs one.
One route: `POST /rewrite`. Caps: payload limits (400), 120 pages/day per
install id (429), and DeepSeek's dashboard spend cap surfaced as 503.

## Deploy (owner-run, one time)

```sh
cd worker
npx wrangler login
npx wrangler kv namespace create RCG_KV
# Paste the id it prints into wrangler.toml, replacing REPLACE_WITH_KV_NAMESPACE_ID.
npx wrangler secret put DEEPSEEK_API_KEY
# Prompts for the key. It goes straight to Cloudflare; never in the repo or shell history.
npx wrangler deploy
# Prints the live URL, e.g. https://rcg-rewrite.<your-subdomain>.workers.dev
```

Also set the monthly spend cap in DeepSeek's dashboard. The Worker turns the
resulting API refusal into a friendly 503; the cap itself lives at DeepSeek.

Redeploys after code changes: just `npx wrangler deploy`.

## Acceptance checks

Set the URL once:

```sh
URL="https://rcg-rewrite.<your-subdomain>.workers.dev"
```

**1. Valid payload → 200 with rewrites**

```sh
curl -s -X POST "$URL/rewrite" -H 'content-type: application/json' -d '{
  "id": "11111111-2222-4333-8444-555555555555",
  "headlines": ["City council votes to close two public libraries amid budget cuts"],
  "settings": { "sarcasm": 6, "humor": "squirrels", "checkedOut": false }
}'
```

**2. Oversized payload → 400** (61 headlines)

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/rewrite" \
  -H 'content-type: application/json' \
  -d "{\"id\":\"11111111-2222-4333-8444-555555555555\",\"headlines\":[$(printf '"headline padding to length %02d",' $(seq 1 61) | sed 's/,$//')],\"settings\":{\"sarcasm\":2,\"humor\":\"dry\",\"checkedOut\":false}}"
```

**3. Daily quota → 121st request gets 429** (fresh id so earlier tests don't skew the count)

```sh
for i in $(seq 1 121); do
  curl -s -o /dev/null -w "$i: %{http_code}\n" -X POST "$URL/rewrite" \
    -H 'content-type: application/json' \
    -d '{"id":"99999999-8888-4777-8666-555555555555","headlines":["Bridge closure snarls commute for months of repairs"],"settings":{"sarcasm":2,"humor":"dry","checkedOut":false}}'
done
```

Requests 1–120 print 200 (request 1 costs one DeepSeek call; the rest are KV
cache hits and still count as pages). Request 121 prints 429.

## Keep in sync

`STYLE_NOTES` and `buildSystemPrompt()` in `index.js` are copies of
background.js. Any prompt change lands in background.js, `tools/compare.js`,
and this Worker in the same commit.
