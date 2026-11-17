# NS Hansard Live

A live, continuously-updating (unofficial) transcript of Nova Scotia House of
Assembly proceedings, plus a link to the latest officially published Hansard
PDF. Static site, no backend, no accounts, no API keys.

**Live transcript** — reconstructed client-side, about once a second, from
StreamText's public captioning feed for the House (`event=NSLegislature`).
**Latest Hansard PDF** — a small sidebar card populated from
[`data/latest-hansard.json`](data/latest-hansard.json), refreshed every 30
minutes by a GitHub Actions workflow that scrapes the Legislature's Hansard
listing page.

## How it works

```
┌─────────────────────┐       ~every 1s, client-side          ┌───────────────────────┐
│ visitor's browser    │ ───────────────────────────────────▶ │ streamtext.net/        │
│ (index.html + app.js)│ ◀─────────────────────────────────── │   text-data.ashx       │
└─────────────────────┘     {lastPosition, i:[entries]}        │ (CORS-open, public)    │
                                                                 └───────────────────────┘

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

1. **CORS on StreamText's feeds**: **open** — `/captions` (tested
   2026-08-24) and `/text-data.ashx`, the feed the site actually uses now
   (tested 2026-11-17, for both its `200` and its `404` responses; see
   finding 4). `curl -I` with an
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
   This first pass could not observe a live session, and that mattered:
   the brief's assumption that `last=0` returns the whole day's backlog
   turned out to be wrong for `/captions` — see finding 4, which corrects
   it. (Idle behaviour of `text-data.ashx` is the same shape of thing:
   `404` with a plain-text `Event not found`, which the site treats as
   "not currently sitting", not as an error.)

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

4. **Live-session behaviour (verified 2026-11-17, during a real
   captioned committee meeting) — and a correction to the original
   brief.** This is the one that caused the site to run badly behind a
   live captioner.
   - **`/captions` pages the backlog in tiny chunks.** The brief assumed
     `last=0` "hands back everything captioned so far that day in one
     large chunk". It doesn't: each call returns roughly 10–35
     *characters* and a cursor to continue from. Against a stream that
     already held ~10,800 characters, catching up at one chunk per
     5-second poll would take over half an hour — and a captioner
     produces text (~12 characters/second here) faster than that
     drains it, so the page fell *further* behind all sitting. The
     original site polled this endpoint every 5 seconds.
   - **`/text-data.ashx` returns the whole backlog in one response.**
     It's the endpoint StreamText's own player uses. `last=0` returned
     all 1,138 entries (12,821 characters, matching `/captions`' own
     character total for the same moment) in a single ~140 ms request.
     Each entry is `{"format":"basic","d":"<percent-encoded text>"}`;
     `%08` is the captioner's backspace. The cursor counts *entries*, not
     characters. `last=-1` returns just the current total, and a cursor
     past the end is simply echoed back with no entries (so a stale
     cursor can't be detected from a normal poll — the site probes with
     `last=-1` when it's been quiet).
   - **StreamText's own player polls every 500 ms**, with a linear
     back-off capped at 10 s (read from its `streamtext-player-app.js`).
     The site now polls about once a second (3 s while idle).
   - **A session can end and a new one can start with its numbering
     reset**, which is why the site re-verifies its cursor against the
     full backlog on page load and after any "event not found", keeping
     the earlier session's text and marking the join with a divider.
   - **Not verified:** what StreamText does with the feed *after* a
     session ends (does it 404 straight away, or keep the day's text?),
     and whether a second session on the same day really restarts the
     numbering. Both matter for the daily archive below.

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
scripts/archive_daily_transcript.py     — full-day transcript fetch + archive (evening)
scripts/google-apps-script/archive-transcript.gs — paste-in source for the Sheets webhook (not deployed via git)
.github/workflows/archive-daily-transcript.yml — runs the archive job twice each evening
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

This overwrites `data/latest-hansard.json` with freshly scraped data.

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
section adds one more piece: an evening job that saves each sitting day's
**full** transcript permanently — not just in a visitor's browser — and
logs it to a Google Sheet.

> **Status: not yet proven against a real sitting day.** It was built on
> the brief's (wrong — see finding 4) assumption about `/captions`, then
> corrected to use `text-data.ashx`, which *is* verified to return a whole
> backlog in one request. What hasn't been observed is how long StreamText
> keeps that backlog available after a session ends. Run the workflow by
> hand (**Actions → Archive daily transcript → Run workflow**) while a
> captioned session is live to see a real archive, and check back after a
> session has ended to see whether the later runs still find content.

**Why this exists / how it differs from the live feature:** the live
transcript only ever accumulates inside whichever visitor's browser has
the page open (that's inherent to the "100% static, no server" design —
see the CORS notes above). Nothing server-side ever sees a *complete*
day's transcript on its own. `.github/workflows/archive-daily-transcript.yml`
fixes that with scheduled runs timed for after the House would
realistically have risen (about 6:15pm and 11:15pm Atlantic, both safely
before midnight in either DST state). Each run requests the live feed
(`text-data.ashx`) with `last=0`, which returns the session's *whole*
backlog in one response, so no continuous server-side polling is needed.
There are two runs because the feed only holds the *current* session: the
early one is a snapshot in case it disappears once the captioner
disconnects, and the late one catches anything said afterwards. A later run
only replaces the day's file if it actually finds content, so an empty late
run never wipes the early snapshot. On a day with no captioning session
(`404`) it skips entirely — no empty file, no Sheet row, no commit. A
malformed response or a failure that outlasts its retries fails the run
loudly (red in the Actions tab) instead of quietly skipping a sitting day.

**Limits to know about:** it archives *one* session per day — whatever the
feed still holds when a run happens — so if the day had several (say a
committee in the morning and the House in the afternoon) and the feed
restarts between them, only the most recent survives. And the day is
labelled by the Atlantic calendar date when the run happens.

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
   own commit step (same as the Hansard-PDF workflow), runs twice each evening on its
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
  (`localStorage["nsHansardLive:v2:<YYYY-MM-DD>"]`), matching how
  StreamText scopes a day's captions. It stores the transcript, the feed
  cursor, and a fingerprint of the session's opening entries; on every page
  load the site re-checks that against the live backlog, so a returning
  visitor only gets the new text appended, never duplicates. (`v2` because
  the cursor changed from a character count to an entry count when the feed
  changed; old `v1` saves are discarded.) A day rollover detected
  mid-session resets the in-memory buffer and cursor and starts fresh.
- **Auto-scroll** follows the live edge of the transcript box until the
  reader scrolls up, and stops following (a "Jump to latest" button
  appears) for as long as they stay there. It's driven by the reader's own
  scroll, not re-measured on every update, so resizing the window or a
  phone's keyboard opening can't silently turn it off.
- **Letter case.** The captioner's software sends almost everything in
  capitals (~99% of the words in a real session), which is tiring to read
  for hours. The site shows a sentence-case rendering by default, with a
  toolbar toggle ("Aa Sentence case" / "AA As captioned") that remembers
  your choice. It is a view only: the stored transcript, and the daily
  archive, keep the captions exactly as sent, and the `.txt` download
  follows whatever view is on (adding a note when it was adjusted). It
  can't *know* what's a name, so it lower-cases capitalised words and puts
  capitals back for sentence starts, "I", a list of acronyms and place
  names (`KEEP_UPPER` / `PROPER_CASE` in `assets/app.js` — extend them
  freely), the name after Ms./Mr./Dr./Madam, and the names after "my name
  is…" and "MLA for…". Words the captioner already sent in mixed case
  (`DeCOSTE`, `MacGillivray`) are left alone. Other names will show in
  lower case; the toggle is one click away when that matters.
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
