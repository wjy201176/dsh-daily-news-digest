# Daily News Digest

A DSH plugin that adds **Daily News Digest** to the left sidebar, below **Plugins**.

## Install

```bash
dsh plugin add dsh-daily-news-digest
```

Or from a checkout, so edits are live:

```bash
dsh plugin add link:/path/to/daily-news-digest
```

The plugin needs the harness `web` service for search and fetch. Signed-in
sources, the PDF report and scheduled email additionally use Microsoft Edge,
Outlook and the DSH schedule service, each of which degrades to a reported reason
when absent rather than failing the run.

## Use

The page has two editors and one button:

- **Topics Interested** — one row per topic (`AI News`, `具身智能`, `LLM Local Deployment`, …).
  Each row has a **+** that opens a **search guidance** box for that topic: free text
  saying what you want and what to skip.
- **Sources Specified** — one row per source. A row may be a website (`CNN.com`), a
  company or personal blog (`QbitAI`, `The Berkeley Artificial Intelligence Research
  Blog`), a forum (`reddit`, `twitter`, `github`, `zhihu`, `weibo`) or a news-data
  provider (`OpenBB`).
- **Top** — how many stories to keep per topic (default 10), then **Summarize**.

## Search guidance

A topic is a label, and a label is a weak query. "LLM Local Deployment" says nothing
about whether you care about vLLM's scheduler, consumer laptops, or enterprise
on-prem rollouts — so the search guesses, and the guess pulls in tutorials and home
pages that are on-topic and useless.

The guidance box is where you say what you actually mean:

> only open-source inference engines like vLLM and llama.cpp. Skip tutorials and
> encyclopaedia entries.

It behaves like a prompt for the search and a skill for the filtering, and it is
**not pasted into the query verbatim** — that sentence would make a terrible search
query. Instead `lib/guidance.js` parses it into three things:

| Piece | Example | What it does |
|---|---|---|
| `keywords` | `vLLM`, `llama.cpp`, `inference` | added to the queries, and added to what the relevance screen counts as on-topic for this run |
| `excludes` | `tutorials`, `homepages` | a hit whose title or snippet matches is dropped before ranking |
| `note` | the sentence as written | handed to the model as editorial direction for the brief and the story lines |

Guidance **narrows; it never replaces.** The topic's own queries still run, so a
guidance that turns out to be too narrow cannot cut the topic's coverage out
entirely. Two extra query shapes are added: the keywords alone, and the keywords
anchored to the topic.

The parser is deliberately conservative. It keeps quoted phrases whole, drops
stopwords and instruction verbs ("skip" is not a search term), splits Chinese
guidance on its list separators and strips the leading filler verb, and treats the
clause after "exclude/skip/avoid/never/不要/排除/忽略" as exclusions rather than search
terms. An exclusion matches the singular, the plural and the spaced compound —
"skip homepages" catches "Home page" — but respects word boundaries, so "guides"
does not match "guided missiles".

Guidance is read **sentence by sentence**, because a sentence can change direction:
in "Skip tutorials. Prefer reuters.com." the second sentence is a preference, and
splitting once at the first marker would have turned `reuters.com` into a rejected
host. A period only ends a sentence when it is followed by a new one, so
`reuters.com`, `llama.cpp` and `v0.5.22` survive intact.

The guidance is stored with its topic, echoed on the digest, and printed in the
stored report, so a reopened digest still says what the search was told.

## Topic skills

Parsed guidance is not the same as an operational plan, so each topic's guidance is
compiled into a **skill** (`lib/skill.js`) with three parts:

| Part | What it is |
|---|---|
| `plan` | Queries ranked by precision, each tagged with the angle that produced it: the reader's quoted phrase, the topic, a roundup, their subjects, subjects anchored to the topic, their preferred hosts, then the beat sweep. Bounded at 14, because search is rate-limited. |
| `fallback` | Broader, **undated** phrasings used only when the plan returns nothing. A dated query is precise and brittle; a thin topic needs width, and a topic the search can reach should not come back blank because one phrasing missed. |
| `criteria` | The guidance restated as statements a reviewer can apply, e.g. *"Reject anything about: tutorials."* |

**The plan is spent in order.** The reader's own subjects come before the wide beat
sweep, so a category topic does not drown its specific request in a list of
companies.

**A review pass applies the criteria.** When a topic has guidance and a model is
available, the candidates are reviewed before ranking: the model gets the guidance
verbatim, the derived criteria and each candidate, and replies with the ones to
drop and why. It may only *remove* — never add, rewrite or reorder — so the ranking
stays the pipeline's decision and the digest stays auditable.

The review fails safe. A reply that would remove every candidate is discarded and
logged, because a confused or hostile model must not blank a topic the deterministic
screens already accepted. Without a model the plan and the hard filters still work;
only the review is skipped.

**It is visible.** Each topic carries `skill` on the digest — the planned queries
with their angles, the criteria, how many candidates were reviewed and what was
removed — and both the page and the stored PDF report it under the guidance line.

## How a topic is searched

A topic is not a query. `AI News` sent to a search engine is read as *a thing to
explain*, so it returns the Britannica entry, AI tool directories, and the
ChatGPT home page. That is how a day carrying the largest IPO in history produced
"no concrete news": eleven queries, six unique results, one Britannica page left
after filtering.

So a query is built, never copied from the topic:

| Piece | Example | Why |
|---|---|---|
| the topic | `AI News` | keeps results *about* the topic |
| a news signal | `news` | asks for reporting, not a definition |
| the day, in words | `October 26 2026` | the strongest recency signal a search engine honours |
| the source, if named | `site:cnn.com` | the row the user specified |

That gives `AI News news October 26 2026 site:cnn.com`.

**A category topic also sweeps its organisations.** "Anthropic files for IPO" is
the biggest AI story of the day and contains neither "AI" nor "News". A beat that
names a category is therefore searched through the real organisations that make
news in it — `OpenAI Anthropic October 26 2026`, `Google DeepMind Nvidia …` — and
a story about any of them is a story in that category. Real beats are searched as
themselves *and* through their organisations; an unknown topic gets the dated
queries only.

The entity lists live in `BEAT_ENTITIES` in `lib/sources.js`. They are a curated
starting point, not a complete index: a story about an organisation missing from
the list is found only if a roundup query surfaces it.

**Each story links to the published article, not to the site that published it.**
A `site:openai.com` query returns `openai.com/research` — the section landing
page — before it returns the day's article. That page is not a news item, so
every hit is judged twice before it can become a story:

- `isArticleUrl()` decides whether the URL addresses one article (a dated path,
  an id-like tail, or a multi-word slug) rather than a listing such as
  `/research`, `/news`, or `/blog`. A section page is dropped; if a provider's
  URLs are simply not article-shaped, the section filter stands down rather than
  emptying the digest.
- `freshnessOf()` recovers the publication date from `publishedAt`, then the URL
  path, then the snippet. A story dated outside `maxAgeDays` (default 0, i.e.
  today) is dropped; an **undated** story is kept and labelled "date unknown",
  because unknown is not stale.

Today's articles outrank undated ones, and both outrank section pages. The page
shows each story's publication date, and the digest records the day it covers.

Reads come from the public counts a page exposes (upvotes, points, comments).
A source with no public count contributes a position-based estimate, and the
digest labels each total as measured or estimated — it never presents an
estimate as a measurement.

The model's job is only what ranking cannot do: one short brief per topic, one
line per story, and folding stories that are the same event under different
headlines. It is told the digest's date and that each story is a published
article, so it describes the news rather than a section's subject area. If no
model is reachable the digest still renders from the ranking.

## Relevance

Ranking alone says nothing about whether a hit is *about* the topic, and search
engines return noise: a Cadillac XT5 forum thread ranked third under "AI News",
because "AI News" is two short generic words and every returned page was taken at
face value.

`lib/relevance.js` now answers one question per hit before anything is ranked: is
this page about the topic? It is lexical and deterministic — no network, no model
— so it works with no provider reachable and its decisions are testable:

- **Word boundaries, not substrings.** `AI` matches the word "AI" and never the
  letters inside "Cadillac".
- **Concept vocabulary in two tiers.** *Strong* terms (`machine learning`,
  `OpenAI`, `Nvidia`, `humanoid`) are conclusive on their own, because the pages
  that are the news often never say the topic word. *Weak* terms (`model`,
  `benchmark`) only add support: "a weather agency upgrades its forecast model"
  mentions a model and is not AI news.
- **The publisher counts.** A page on `openai.com` is about OpenAI even when its
  headline says only "Introducing GPT-6".
- **Chinese topics** match concept words rather than the topic's own bigrams,
  because an article says 人形机器人 where the topic says 具身智能.

Three outcomes, not two. A certain match is **kept**, a certain miss is
**dropped**, and the middle is **grey**: kept, but flagged, so the model gets a
chance to veto it. The model is asked only about the grey zone, and only ever to
*remove* — a hit the lexical screen called relevant is never dropped on a model's
word alone.

The screen fails safe in one direction only: it will not empty a digest that has
real evidence, but it will report "no relevant news" rather than rescue pages
with none. Rescuing those would put the original bug straight back.

Two related defects were fixed alongside it. A publication date outside a
believable window (a forum timestamp rendered as the year 7969) is now treated as
*undated* rather than trusted — it looked precise, survived the recency filter,
and could outrank real news. And the source count now counts **publishers**, not
search plans: one page found by two queries, or one outlet's two subdomains, used
to count as two independent sources, inflating the ranking's top signal.

### A compound topic is not its category word

`LLM Local Deployment` is not satisfied by anything that mentions a language model.
Its head word (`llm`) names the domain; `local` and `deployment` are what the reader
asked for. Treating the head word as sufficient let a Gemini model review, a
Gemini cyber-defender policy note and an AI-safety story about who can "pull the
plug" into a digest about running models on your own hardware — all three ranked.

So `topicQualifiers()` separates the topic's own discriminating words from the ones
that only name a category (`ai`, `llm`, `news`, `geopolitics`, `economics`,
`science`, `global`, …). When a topic has qualifiers, a hit must show evidence of
at least one of them — in any of a small set of synonyms, because a story about
self-hosting never says "local deployment", and it may instead carry a subject the
reader named in their guidance.

A topic with no qualifiers is a category, and keeps the behaviour it had: `AI News`
and `Geopolitics` still lean on their alias expansion.

The same distinction decides the **beat sweep**. A category has no reporting under
its own name, so it is swept through the organisations in its field — that is how
the Anthropic IPO was found under "AI News". A specific topic does have reporting
under its own name, and sweeping general AI companies for it returns exactly the
general AI news the reader did not ask for. So the sweep runs only for categories.

### Only open models can be deployed locally

A deployment topic carries a rule the others do not: a model whose weights are not
published cannot be self-hosted, so a story about a hosted model is about *using*
it, not about running it. `requiresOpenSource()` derives the rule from the
qualifiers — it applies to `local`/`deployment`/`self-host` topics and to nothing
else, so `AI News` and `Geopolitics` are unaffected.

The rule reaches the pipeline twice:

- as a **criterion** the reviewer applies, stated in the same words a reader would:
  a story about a closed model is out of scope unless it also concerns an
  open-weight model;
- as a **deterministic filter** in `applySkillFilters()`, so it holds when no model
  is available.

Evidence of openness is what counts: a named open-weight family (`Qwen`, `Llama`,
`DeepSeek`, `Mistral`, `Gemma`, …), a runtime that only serves self-hosted weights
(`Ollama`, `vLLM`, `SGLang`), a file format (`GGUF`, `GPTQ`, `AWQ`), or the licence
language of an open release. Language about running *something* locally does not
count — "Gemini can now run locally" says where a closed model executes, and
counting that as openness was the first draft of this rule and it let the exact
story the reader objected to straight through.

## Relevance is not news

Being about the topic is necessary and not sufficient. A second judgement asks
what *kind* of page a hit is, because a Britannica entry, a home page and a Zhihu
tutorial are all genuinely about AI and none of them reports anything that
happened — yet all three were ranked as if they were the day's news.

`lib/newsworthiness.js` scores each hit 0–10 against a threshold, the shape
Horizon uses for its profiles, with two rules doing most of the work:

- **Some page kinds are never news**, however relevant: a home page, an
  encyclopaedia entry, a tag listing, a tutorial, a Q&A answer. These are dropped
  outright. A dated headline cannot rescue a home page.
- **Everything else needs evidence of an event.** A publication date, an event
  verb ("files", "launches", "unveils", "发布", "宣布"), a figure, or a dated
  roundup. An undated page with none of those is evergreen material, not news.

Two subtleties the tests pin. A dated roundup counts as reporting even with no
verb — "International News Briefs for Monday, October 26, 2026" is the day's
events, collected — so `freshnessOf()` now also reads a date out of the *title*,
which is where roundups put it. And a Quora *answer* is a question page while a
Quora *Space* is a personal blog: the subdomain decides, so the host check is
exact for Q&A and suffix-based for the rest.

The page reports the two filters separately, because they are different things:
"filtered out N unrelated results" and "skipped N on-topic pages that were not
news".

## History

Every finished run is kept, newest first, up to 50 digests — the **contents**, not
just a row: each stored digest keeps every topic brief, every story, its links,
dates and read counts. So a stored digest is a real document that can be reopened
later, not a pointer that needs a fresh search to mean anything.

The page shows the stored runs as a timeline above the results: each row carries
the run's timestamp, how many topics and stories it held, and the topic names.
**Pressing a row opens that digest in its own Microsoft Edge window** — a
standalone page at full window size, rather than a panel squeezed into the
sidebar. The window is a normal `--app=<url>` launch of the user's own Edge, so
the links inside it open signed in with the profile they already have; when Edge
is already running, Chromium opens the app window in that instance instead of
starting a second browser.

The document is written to a file (`%TEMP%\dsh-daily-news-digest\<digest-id>.html`)
and opened over `file://`, **not** served from the plugin's HTTP route. A report is
static — no script, no stylesheet, no data to fetch — so it never needed a server.
Serving it meant the window's success depended on the app's listener, a token, and
a route handler not throwing; a handler that threw left the connection open with
no response, which Chromium shows as **"This page isn't responding"**. A file
cannot fail that way, and reopening a digest overwrites its own file rather than
accumulating copies.

Each row has its own delete button. Deleting removes that one digest from the
state file and leaves the others alone; deleting the digest currently on screen
also clears the screen, so the page cannot show a result whose stored copy is
gone.

The timeline is *not* the results area: opening the page shows the editors and
the timeline, and the digest area stays empty until you press Summarize.

| Route | What it does |
|---|---|
| `POST /open` `{ id }` | Write the report file and launch the Edge window at it |
| `GET /digest?id=<id>` | The stored digest as JSON |
| `POST /history/delete` `{ id }` | Drop one digest, answering with the survivors |

There is no public report route any more. That is deliberate: a served report
needed a credential the window could carry (the token the code used to mint) and
a listener that never failed — both of which were failure modes for no benefit,
since the document is self-contained.

## Signed-in sources

Some sources only answer a signed-in reader: `x.com` returns "Log in to X" to an
anonymous request, and Zhihu, Weibo, LinkedIn and Reddit behave the same way at
various times. The user is already signed in inside Edge, so the plugin reuses
those credentials.

`lib/cookies.js` reads Edge's Chromium cookie database. Each value is
AES-256-GCM ciphertext under a master key that Windows DPAPI protects in
`Local State`, so reading it is a two-step unwrap: DPAPI (via one PowerShell
call, base64 in and out) unlocks the key, the key decrypts the cookie.

`lib/fetch-auth.js` then fetches the page directly, because the harness
`ctx.web.fetch()` seam has no header surface — it always sends its own
User-Agent and no cookies, which is exactly why a walled page comes back as a
login form. Only login-walled hosts take this path; every other source stays on
the harness service.

**The lock is the real constraint.** While Edge is running it holds the cookie
database with no sharing at all: a byte copy fails with `EBUSY`, a read-only
SQLite open fails, a share-mode open fails, and even a backup-mode copy needs a
privilege the plugin does not have. No amount of retrying changes that.

So the snapshot is **saved and reused**. A successful read writes
`$DSH_HOME/daily-news-digest/edge-cookies.json`, and a later read that finds the
database locked falls back to that file instead of reporting failure. The plugin
also tries to capture a snapshot at startup and every two minutes while loaded,
because a read can only succeed in a gap when Edge is closed — that gap is found
without the user having to close Edge on purpose.

The effect is that the "quit Edge" instruction appears **at most once**, and only
when no snapshot exists yet. After the first successful capture, a running Edge no
longer blocks the digest: the page says the cookies came from a saved copy and how
old it is. A snapshot is discarded when every dated cookie in it has expired, so
dead credentials are never replayed — that would produce a login wall that looks
like a broken account.

`digest.notes.cookies` still carries the reason when nothing is usable, and the
digest continues with an anonymous fetch rather than failing.

## Scheduled runs and email

A scheduled run is the only run that emails. Pressing **Summarize** never sends
mail: it shows the result on screen, and a surprise email is not what that button
promises.

**DSH has no mail capability.** The whole shipped bundle contains no SMTP client,
no mail library and no send tool. So mail goes out through the mail client already
on the machine and already signed in — Outlook, driven over its COM automation
interface (`lib/mail.js`). That needs no password and stores no secret, and the
message lands in the user's own Sent Items. The cost is that Outlook must be
running, and that Outlook may raise a security prompt the first time another
program sends on its behalf; a failed send is reported as a reason, never as a
success.

**The PDF is printed by the Edge the user already has** (`lib/pdf.js`), from the
same HTML the report window shows, so the emailed copy cannot drift from the
on-screen one. `--headless --print-to-pdf` needs no window and no display; a
throwaway `--user-data-dir` is used because Edge will not start headless against a
profile a normal window already holds.

Story URLs are printed under each headline as well as linked, because a printed or
forwarded PDF loses the click target and the reader would have no way to reach the
article.

**The schedule itself is a DSH reminder**, created with the harness schedule tool
(`daily` at 18:00 in the machine's zone). DSH delivers a reminder into a Session —
it does not run background jobs — so the run happens at 6pm when DSH is open and at
the next launch otherwise. The reminder's instruction calls
`POST /daily-news-digest/api/scheduled-run` with a token the plugin generates and
keeps in `$DSH_HOME/daily-news-digest/scheduled-token.txt`. The endpoint is
separate from `/run` on purpose: it is the only path that emails, and it cannot be
triggered by the page.

| Setting | Default | Meaning |
|---|---|---|
| `mailTo` | `''` | Where a scheduled run emails its PDF. Empty means no email. |
| `reportLang` | `en` | Language of the emailed report and message. |
| `scheduledToken` | generated | Overrides the token kept on disk. |

## Where things live

| Path | Role |
|---|---|
| `index.js` | Host half: saved state, digest job, HTTP routes |
| `client.js` | Client half: sidebar entry and the page |
| `lib/sources.js` | Source rows → searchable plans and attribution |
| `lib/recency.js` | Article-vs-section judgement and publication dates |
| `lib/relevance.js` | Topic screening: is this hit about the user's topic? |
| `lib/guidance.js` | Per-topic search guidance: keywords, exclusions, the note for the model |
| `lib/skill.js` | Compiles guidance into a query plan, a fallback plan and review criteria |
| `lib/pdf.js` | Print the report HTML to PDF with headless Edge |
| `lib/mail.js` | Compose the digest email and send it through Outlook |
| `lib/newsworthiness.js` | News screening: is this page reporting an event? |
| `lib/cluster.js` | Grouping hits into stories, ranking, link choice |
| `lib/engagement.js` | Reading public engagement counts |
| `lib/cookies.js` | Reading the user's Edge cookies (DPAPI + AES-GCM) |
| `lib/fetch-auth.js` | Fetching a login-walled page with those cookies |
| `lib/summary.js` | The model prompt, its reply, and the fallback digest |
| `lib/digest.js` | One run: search → attribute → measure → rank → summarize |
| `lib/state.js` | Persisted topics, sources, `top`, the digest timeline |
| `lib/report.js` | One stored digest → the standalone HTML an Edge window shows |
| `lib/launch.js` | Writing the report file and launching one Edge `--app` window |
| `lib/llm.js` | Choosing the model route for a run |

State is written to `$DSH_HOME/daily-news-digest/state.json`.

## Configuration

Every tunable is a `config` field on the plugin row in `cordis.patch.yml`, so it
survives upgrades:

```yaml
- id: daily-news-digest
  name: dsh-daily-news-digest
  config:
    deadlineMs: 180000      # hard stop for one run
    perTopicResults: 6      # results asked per (topic, source) query
    searchConcurrency: 4
    fetchConcurrency: 3
    fetchBudget: 24         # page fetches per run, for engagement measurement
    llmTimeoutMs: 90000
    maxAgeDays: 0           # 0 = today only; 1 = today and yesterday; undated kept
    reportWidth: 1100       # the Edge window opened for a stored digest
    reportHeight: 900
    edgePath: ""            # empty = find Edge in its usual install locations
```

## Verification limits

Search and fetch go through the harness `web` service, so they use whatever
providers the profile mounts. A profile without a usable search provider still
opens the page and saves the editor, but Summarize reports that no results came
back.

The engine matters more than the queries. On a machine where the profile's search
provider returned encyclopaedia pages for English news queries, five of six topics
came back empty; pointing it at a provider that indexes news fixed the coverage
without any code change. If a run looks thin, check the provider before the plugin.

## Tests

```bash
npm test
```

315 assertions across 20 files, covering query construction, both screens, the
topic-qualifier gate, the open-source rule, the ranking contract, guidance parsing, skill planning and
its fallback, the review pass and its fail-safe, the cookie cache, the report
renderer, the scheduled-delivery path and the client page.

## License

MIT — see [LICENSE](LICENSE).

