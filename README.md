# NS Hansard Live

A live, continuously-updating (unofficial) transcript of Nova Scotia House of
Assembly proceedings, plus a link to the latest officially published Hansard
PDF. Static site, no backend, no accounts, no API keys.

**Live transcript** — reconstructed client-side, every 5 seconds, from
StreamText's public captioning feed for the House (`event=NSLegislature`).
**Latest Hansard PDF** — a small sidebar card populated from
[`data/latest-hansard.json`](data/latest-hansard.json), refreshed every 30
minutes by a GitHub Actions workflow that scrapes the Legislature's Hansard
listing page.

## How it works

```
┌─────────────────────┐        every 5s, client-side          ┌───────────────────────┐
│ visitor's browser    │ ───────────────────────────────────▶ │ streamtext.net/captions│
│ (index.html + app.js)│ ◀─────────────────────────────────── │ (CORS-open, public)    │
└─────────────────────┘        {content, lastPosition}        └───────────────────────┘

┌─────────────────────┐   same-origin fetch of committed file  ┌───────────────────────┐
│ visitor's browser    │ ───────────────────────────────────▶ │ data/latest-hansard.json│
└─────────────────────┘                                        └───────────────────────┘
          ▲
          │ commits when content changes
┌─────────────────────┐   every 30 min, server-side (Actions)  ┌───────────────────────┐
│ GitHub Actions       │ ───────────────────────────────────▶ │ nslegislature.ca        │
│ scripts/update_...py │ ◀─────────────────────────────────── │ (no CORS — must scrape  │
└─────────────────────┘        HTML listing page               │  server-side)          │
                                                                 └───────────────────────┘
```

## §5 verification findings (as required by the brief)

Tested 2026-08-24, a non-sitting day, from the CLI and from a real browser
tab pointed at the official `streamtext.net/player?event=NSLegislature`
page.

1. **CORS on `streamtext.net/captions`**: **open**. `curl -I` with an
   `Origin` header gets back `access-control-allow-origin: <the origin sent>`
   (it reflects any origin) and `vary: origin`. This is a simple GET with no
   custom headers, so no preflight is triggered — a plain client-side
   `fetch()` works from a GitHub Pages origin. **Conclusion: the live
   transcript can be, and is, 100% static** — no proxy needed, exactly the
   preferred outcome the brief called out.

2. **Endpoint behaviour outside sitting hours**: on a day with no sitting,
   `GET /captions?event=NSLegislature&last=0&language=en` returns **HTTP
   404** with a **JSON body** `{"content":"","lastPosition":-1,"languageCode":""}`.
   That's a deviation worth flagging from a literal reading of the brief
   (which implies a `200` with empty `content` as the idle state) — in
   practice StreamText returns 404-with-JSON when the event has no
   content for the day. The app therefore always attempts to parse the
   response body as JSON regardless of HTTP status, and treats
   `lastPosition < 0` (or a parse failure / network error) as "not
   currently sitting" / idle, rather than branching on status code. This
   was confirmed both via `curl` against `/captions` directly and by
   watching the real player's own network calls to its actual endpoint
   (`text-data.ashx`, which 404s with a plain-text `Event not found` body
   on an idle day) — same underlying behaviour, different endpoint.
   We could not observe the live/in-session response shape directly since
   testing happened outside sitting hours; the documented shape from the
   brief (`{"content": "...", "lastPosition": N}`) is what the polling and
   backspace-handling code targets, and it degrades safely (falls back to
   the idle state) if a response doesn't match.

3. **Hansard listing page structure**: confirmed current. Fetched
   `https://nslegislature.ca/legislative-business/hansard-debates/assembly-65-session-1`
   directly — it's still a Drupal Views table
   (`table.views-table`) with exactly the five columns described in the
   brief (Sitting / Hansard date / Pages / Hansard video / Hansard PDF),
   most recent sitting first, and the top row (`26-59`, an upcoming
   sitting) indeed has a blank PDF cell while the next row down (`26-58`,
   2026-Apr-9) has the populated link — i.e. the brief's example row is
   real, current data, not a hypothetical. Also confirmed a more robust
   way to find the *current* Assembly/Session than hardcoding
   `assembly-65-session-1`: the Hansard index page
   (`/legislative-business/hansard-debates`) has an "Assembly (date)"
   `<select id="edit-hansard-session-redirect">` filter whose
   `selected` option is always the current session (currently
   `65-1 (2024 - 2026)`). `scripts/update_latest_hansard.py` reads that
   dropdown first and only falls back to a hardcoded URL if the markup
   ever changes underneath it.

## Repo layout

```
index.html                              — the whole frontend page
assets/style.css                        — theming (light/dark), layout, typography
assets/app.js                           — polling, backspace reconstruction, search,
                                           persistence, scroll behaviour, theme toggle
data/latest-hansard.json                — latest official Hansard PDF reference (auto-updated)
scripts/update_latest_hansard.py        — scraper run by the workflow below
scripts/requirements.txt                — Python deps for both scripts below
.github/workflows/update-latest-hansard.yml — runs the Hansard-PDF scraper every 30 min

transcripts/<YYYY-MM-DD>.txt            — one full day's archived transcript (optional feature, auto-created)
scripts/archive_daily_transcript.py     — nightly full-day transcript fetch + archive
scripts/google-apps-script/archive-transcript.gs — paste-in source for the Sheets webhook (not deployed via git)
.github/workflows/archive-daily-transcript.yml — runs the nightly archive job
```

## Local development

No build step. Any static file server works, e.g.:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. (Opening `index.html` directly via
`file://` mostly works too, except the same-origin `fetch()` of
`data/latest-hansard.json` may be blocked by the browser depending on its
`file://` fetch policy — a local server sidesteps that.)

To exercise the scraper locally:

```bash
pip install -r scripts/requirements.txt
python3 scripts/update_latest_hansard.py
```

### Test mode

The House isn't sitting most of the time, which makes the live-transcript
feature hard to actually see working. Append `?testmode=1` to the URL
(e.g. `http://localhost:8000/index.html?testmode=1`, or on the deployed
site) to feed a simulated caption script through the *exact same*
accumulation/render/scroll code real polling uses, instead of contacting
StreamText. It demonstrates streaming text, a live backspace
self-correction, auto-scroll, the "jump to latest" button, search, and
the `.txt` download (labelled as simulated in its own header) — all
without needing a real sitting.

A purple banner marks the page as being in test mode the whole time, with
an "Exit test mode" link that drops the query param and returns to the
real feed. Test-mode content is in-memory only — it's never written to
the real day's localStorage entry, and reloading without `?testmode=1`
shows the real (usually empty, outside sitting hours) transcript exactly
as before, untouched.

This overwrites `data/latest-hansard.json` with freshly scraped data.

## Deploying to GitHub Pages

1. Push this repo to GitHub.
2. In **Settings → Pages**, set **Source** to "Deploy from a branch",
   branch `main`, folder `/ (root)`.
3. In **Settings → Actions → General → Workflow permissions**, make sure
   "Read and write permissions" is enabled — the update workflow commits
   back to the repo (`permissions: contents: write` is already declared in
   the workflow file, but the repo-level default also needs to allow it).
4. That's it for the core site — no secrets, no environment variables,
   nothing to configure. The scheduled workflow starts running on its own
   (GitHub may delay the very first scheduled run by a few minutes to a
   few hours after a repo goes public/active; you can also trigger it
   immediately from the **Actions** tab via "Run workflow", since it's set
   up with `workflow_dispatch` too). The optional daily transcript archive
   below does need two secrets if you want it.
5. Open `assets/app.js` and update the `REPO_URL` constant near the top to
   point at your actual repo, so the footer's "Source on GitHub" link is
   correct.

### A note on the Assembly/Session TODO

`scripts/update_latest_hansard.py` auto-detects the current
Assembly/Session from the Hansard index page's filter dropdown, so it
should keep working across Assemblies/Sessions without any manual update.
`FALLBACK_SESSION_URL` in that file is a hardcoded backstop
(`assembly-65-session-1` as of this writing) used only if that
auto-detection ever fails — there's a `TODO` comment right above it flagging
where to bump it if that ever happens.

## Daily transcript archive (optional)

Everything above is the core project and needs nothing further. This
section adds one more piece: a nightly job that saves each sitting day's
**full** transcript permanently — not just in a visitor's browser — and
logs it to a Google Sheet.

**Why this exists / how it differs from the live feature:** the live
transcript only ever accumulates inside whichever visitor's browser has
the page open (that's inherent to the "100% static, no server" design —
see the CORS notes above). Nothing server-side ever sees a *complete*
day's transcript on its own. `.github/workflows/archive-daily-transcript.yml`
fixes that with one scheduled job per day, timed for after the House
would realistically have risen. It calls the captions endpoint with
`last=0`, which — per StreamText's documented behaviour — hands back
*everything* captioned that day in one response, so a single end-of-day
fetch is enough; no continuous server-side polling needed. On a day with
no sitting it detects that (empty content) and skips entirely — no empty
file, no Sheet row, no commit.

**Where the data ends up:**
- The full transcript is committed to `transcripts/<YYYY-MM-DD>.txt` in
  this repo — versioned, diffable, no size limit, and it turns this repo
  into a browsable archive of every past sitting day, not just today's.
- A Google Sheet gets one summary row per day (date, sitting/pages if
  available, word/char counts, and a link to the file above). The full
  text intentionally isn't crammed into the Sheet itself — a single
  Sheets cell caps out at 50,000 characters, which a full sitting day's
  transcript can plausibly exceed. The Sheet is a lightweight index
  pointing at the real files, not the storage itself.

### Setup

1. **Create the Sheet-side webhook.** Open (or create) the Google Sheet
   you want the daily log in, then follow the setup steps at the top of
   [`scripts/google-apps-script/archive-transcript.gs`](scripts/google-apps-script/archive-transcript.gs) —
   paste that file into Extensions → Apps Script, set a script property
   for a shared secret, and deploy it as a Web App. You'll end up with two
   values: the deployed `/exec` URL, and the random secret string you
   picked.
2. **Add two GitHub repository secrets** — **Settings → Secrets and
   variables → Actions → New repository secret**:
   - `SHEETS_WEBHOOK_URL` — the Apps Script `/exec` URL from step 1.
   - `SHEETS_WEBHOOK_TOKEN` — the same shared-secret string from step 1.
3. Done. The workflow already has `permissions: contents: write` for its
   own commit step (same as the Hansard-PDF workflow), runs nightly on its
   own schedule, and can be triggered manually from the **Actions** tab to
   test it (`workflow_dispatch`) without waiting for the actual schedule —
   though a manual run outside sitting hours will just correctly report
   "no content" and skip, same as the schedule would.

If you skip this whole section, the rest of the site is completely
unaffected — the live transcript, search, download, and Hansard PDF card
all work exactly the same either way. Without the two secrets set, the
workflow's notify step just logs that it's skipping and exits cleanly
(the transcript still gets archived to the repo either way — only the
Sheet row is skipped).

## Design notes

- **Idle vs. live vs. error** are three distinct, clearly-labelled states in
  the status badge — the app never presents a network hiccup as "the House
  isn't sitting" or vice versa (a couple of consecutive fetch failures are
  tolerated silently before surfacing a "connection issue" badge, since
  brief network blips shouldn't cause visible flicker).
- **Persistence** is keyed by the current Atlantic-time date
  (`localStorage["nsHansardLive:v1:<YYYY-MM-DD>"]`), matching how
  StreamText scopes a day's captions. A day rollover detected mid-session
  resets the in-memory buffer and cursor and starts fresh.
- **Auto-scroll** tracks whether the reader is near the bottom of the
  transcript specifically (not the whole page, which also has the sidebar
  and footer below it) and only snaps down automatically when they were
  already there; otherwise a "Jump to latest" button appears.
- **Search** does a plain case-insensitive substring scan (not regex) over
  the accumulated transcript, so special characters in a search query are
  never misinterpreted, and highlights/count/next-prev stay correct as new
  text streams in underneath.

## Disclaimer

This project is not affiliated with, endorsed by, or operated by the Nova
Scotia House of Assembly. The live transcript is an unofficial,
automatically-generated reconstruction of a public captioning feed and may
contain errors, omissions, or misattributions. The official record of
proceedings is the published Hansard PDF, linked directly from this page's
sidebar and available at
[nslegislature.ca/legislative-business/hansard-debates](https://nslegislature.ca/legislative-business/hansard-debates).
