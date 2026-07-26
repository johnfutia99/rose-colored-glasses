// Taste test: run the same headlines through DeepSeek at three sarcasm levels.
// Use this to tune the prompt. The jokes are the product.
//
// Usage:
//   DEEPSEEK_API_KEY=sk-... node tools/compare.js [humor]
//   DEEPSEEK_API_KEY=sk-... node tools/compare.js squirrels
//
// Needs Node 18+ (uses global fetch). Runs three calls in parallel.

const HUMOR = process.argv[2] ?? "wholesome";
const LEVELS = [2, 6, 10];

const HEADLINES = [
  "Wildfire forces thousands to evacuate as winds shift overnight",
  "Global markets slide for third straight day on rate fears",
  "City council votes to close two public libraries amid budget cuts",
  "Record heat wave strains power grid across the Southwest",
  "Massive data breach exposes millions of customer records",
  "Housing prices climb again as inventory hits historic low",
  "Bridge closure snarls commute for months of repairs",
  "Study finds microplastics in most bottled water brands",
  "Airline cancels hundreds of flights ahead of holiday weekend",
  "Drought pushes ranchers to sell off herds early",
  "Local factory announces layoffs affecting 800 workers",
  "New report warns coastal flooding will worsen by 2040",
  "Traffic deaths rise for second consecutive year",
  "Grocery prices outpace wage growth for most households",
  "Aging water pipes blamed for latest boil notice",
  "Hospital ER wait times hit record levels statewide",
  "Invasive species threatens native fish in area lakes",
  "Downtown vacancy rates climb as offices sit empty",
  "School district faces teacher shortage as year begins",
  "Storm damage estimates climb into the hundreds of millions"
];

// Keep this in sync with buildSystemPrompt in background.js.
const STYLE_NOTES = {
  wholesome: "Warm, earnest, golden-retriever energy.",
  dry: "Deadpan and understated. No exclamation points.",
  absurd: "Surreal leaps and unexpected imagery.",
  dad: "Puns and dad jokes wherever possible. Occasionally threaten to pull the car over.",
  unhinged: "Unhinged optimism. Everything is somehow wonderful.",
  feet: "A narrator with a barely concealed passion for beautiful feet. Stories drift toward the theme sideways — an elegant arch here, a bare heel on cool tile there, sometimes only a wistful mention of sandals or tiptoes. Vary the imagery; some headlines barely hint, and the word 'feet' should appear only occasionally. Breathy reverence, wistful sighs, suggestive innuendo. Flirt with the line but never cross it: no explicit acts, nothing graphic. Admire feet in the abstract only, never the feet of named real people.",
  squirrels: "Retell every story through squirrel life: acorn markets, branch commutes, nest renovations, winter hoards, hawk scares, tail drama. The cast is ambitious, in over their heads, and doing their best. Most rewrites should evoke the squirrel world without over-using the word 'squirrel' itself — the theme emerges across a page, not in every line. Play with it and be imaginative with creative storylines from a squirrel's perspective.",
  shakespeare: "Triumphant Elizabethan proclamations. Hark, forsooth, much rejoicing. Throw in an occasional direct Shakespearean insult when contextually appropriate.",
  infomercial: "Late-night infomercial pitchman. Every story is an incredible deal, and wait, there's more.",
  midwest: "Midwest nice. Everything is 'not too bad' and 'could be worse, honestly.' Ope."
};

function systemPrompt(sarcasm) {
  const style = STYLE_NOTES[HUMOR] || STYLE_NOTES.wholesome;
  return [
    "You rewrite news headlines into happier versions.",
    `Humor style: ${style}`,
    "Vary your angle, imagery, and sentence shape across the batch. Never reuse the same joke structure or signature word twice.",
    `Sarcasm level: ${sarcasm}/10. 0 means fully sincere. 10 means dripping, satirical-newspaper-grade sarcasm.`,
    "Keep the core facts recognizable. Deliver the real information, just with levity and grace. Turn the edge and anger off.",
    "Keep each rewrite under 140 characters.",
    "You will receive a JSON array of headlines.",
    "Return ONLY a JSON array of strings. Same length, same order. No commentary. No markdown fences."
  ].join(" ");
}

async function callDeepSeek(sarcasm) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("Set DEEPSEEK_API_KEY first.");
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${key}`
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      max_tokens: 4096,
      messages: [
        { role: "system", content: systemPrompt(sarcasm) },
        { role: "user", content: JSON.stringify(HEADLINES) }
      ]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`DeepSeek: ${data?.error?.message || res.status}`);
  return JSON.parse(data.choices[0].message.content.replace(/```json|```/g, "").trim());
}

(async () => {
  console.log(`\nHumor "${HUMOR}" at sarcasm ${LEVELS.join(", ")}\n${"=".repeat(70)}`);
  const started = Date.now();
  const results = await Promise.all(LEVELS.map(callDeepSeek));
  console.log(`All responses in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  HEADLINES.forEach((original, i) => {
    console.log(`ORIGINAL   ${original}`);
    LEVELS.forEach((level, j) => {
      console.log(`SARCASM ${String(level).padEnd(2)} ${results[j][i] || "(missing)"}`);
    });
    console.log("-".repeat(70));
  });
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
