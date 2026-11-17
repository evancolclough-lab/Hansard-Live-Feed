#!/usr/bin/env python3
"""
Fetches the day's live-caption transcript from StreamText's live text feed in
one request and writes it to transcripts/<date>.txt for the workflow to commit.

Which feed, and why: StreamText has two. The documented /captions endpoint
returns the backlog in tiny pages (roughly 10-35 characters per request), so
a single call to it would capture only the first few words of the day — the
original version of this script did exactly that. text-data.ashx (the feed
StreamText's own player uses) returns the entire backlog for last=0 in one
response, as a list of entries whose text is percent-encoded; "%08" is the
captioner's backspace. The live site reads the same feed.

Run by .github/workflows/archive-daily-transcript.yml in the evening, after
the House would realistically have risen. On a day with no captioning
session StreamText answers 404 ("Event not found"); this script then exits
cleanly without writing anything — see GITHUB_OUTPUT's has_content flag,
which the workflow checks before its commit/notify steps.

Known limit: the feed only holds the *current* session. If StreamText drops
the event once the captioner disconnects, or a second session starts later
the same day, only what is still available when this runs can be archived.
That's why the workflow runs more than once an evening: a later run only
replaces the day's file when it actually finds content.

This script does NOT talk to Google Sheets directly and does NOT commit to
git — see the workflow file for that. It only: fetches, reconstructs,
writes the local file, and reports outputs for later workflow steps.
"""

import json
import os
import sys
from datetime import date, datetime
from pathlib import Path
from urllib.parse import unquote

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

try:
    from zoneinfo import ZoneInfo
    ATLANTIC = ZoneInfo("America/Halifax")
except Exception:  # pragma: no cover
    from datetime import timezone, timedelta
    ATLANTIC = timezone(timedelta(hours=-3))

EVENT_NAME = "NSLegislature"
FEED_URL = f"https://www.streamtext.net/text-data.ashx?event={EVENT_NAME}&last=0"
BACKSPACE = "\x08"

REPO_ROOT = Path(__file__).resolve().parent.parent
TRANSCRIPTS_DIR = REPO_ROOT / "transcripts"
LATEST_HANSARD_PATH = REPO_ROOT / "data" / "latest-hansard.json"

HEADERS = {
    "User-Agent": "ns-hansard-dashboard-bot/1.0 (public data updater; see repo README)"
}


def make_session() -> requests.Session:
    """A session that retries transient failures. A single hiccup shouldn't
    cost us the whole day: there is no second chance until the next run."""
    session = requests.Session()
    retry = Retry(
        total=4,
        backoff_factor=2,  # a growing pause between attempts (seconds to tens of seconds)
        status_forcelist=(500, 502, 503, 504),
        allowed_methods=("GET",),
    )
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


def decode_entries(entries: list) -> str:
    """Join the feed's entries into raw text. Each entry's `d` is
    percent-encoded UTF-8. Only plain-text ("basic") entries are used — same
    rule as the live site — so other formats (e.g. speech-recognition text)
    can't pollute the transcript."""
    parts = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        encoded = entry.get("d")
        if not isinstance(encoded, str):
            continue
        fmt = entry.get("format")
        if fmt and fmt != "basic":
            continue
        parts.append(unquote(encoded, errors="replace"))
    return "".join(parts)


def apply_backspaces(content: str) -> str:
    """Same rule the frontend uses: a literal \\x08 deletes the previous
    character rather than being rendered as text."""
    chars = []
    for ch in content:
        if ch == BACKSPACE:
            if chars:
                chars.pop()
        else:
            chars.append(ch)
    return "".join(chars)


def fetch_full_transcript(session: requests.Session) -> tuple[str, bool]:
    """Returns (transcript_text, had_content). had_content is False when no
    captioning session is active (404) or the session has no text yet.

    Anything else unexpected — an HTTP error that outlasted the retries, or
    a 200 that isn't the feed's JSON — raises, so the workflow run fails
    visibly. Quietly skipping would mean silently losing a sitting day."""
    resp = session.get(FEED_URL, headers=HEADERS, timeout=(10, 60))
    if resp.status_code == 404:
        return "", False  # "Event not found": what every non-sitting day looks like
    resp.raise_for_status()

    data = resp.json()
    entries = data.get("i") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise ValueError("Unexpected feed response: no entry list in the JSON")

    transcript = apply_backspaces(decode_entries(entries))
    return transcript, len(transcript.strip()) > 0


def best_effort_sitting_metadata(day: date) -> dict:
    """data/latest-hansard.json describes the most recently *published*
    Hansard, which is normally an earlier sitting (the official PDF usually
    appears days later). So only use its sitting/pages when its date really
    is `day`; otherwise leave them blank rather than stamping today's archive
    with an old sitting's numbers."""
    blank = {"sitting": "", "pages": ""}
    try:
        data = json.loads(LATEST_HANSARD_PATH.read_text())
        published = datetime.strptime(data["date"], "%Y-%b-%d").date()  # e.g. "2026-Apr-9"
    except (OSError, ValueError, KeyError, TypeError):
        return blank
    if published != day:
        return blank
    return {"sitting": data.get("sitting", ""), "pages": data.get("pages", "")}


def write_github_output(**kwargs) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a") as f:
        for key, value in kwargs.items():
            f.write(f"{key}={value}\n")


def main() -> int:
    now = datetime.now(ATLANTIC)
    date_str = now.strftime("%Y-%m-%d")

    transcript, had_content = fetch_full_transcript(make_session())

    if not had_content:
        print(f"No transcript content for {date_str} — House likely wasn't sitting. Skipping.")
        write_github_output(has_content="false")
        return 0

    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = TRANSCRIPTS_DIR / f"{date_str}.txt"

    meta = best_effort_sitting_metadata(now.date())
    header = "\n".join([
        "NOVA SCOTIA HOUSE OF ASSEMBLY — UNOFFICIAL DAILY TRANSCRIPT ARCHIVE",
        f"Source: StreamText.net live captioning feed (event=\"{EVENT_NAME}\")",
        f"Date: {date_str} (Atlantic Time)",
        "",
        "DISCLAIMER: This is an unofficial, auto/captioner-generated transcript",
        "and may contain errors, omissions, or misattributions. It is NOT the",
        "official record. The official record is the published Hansard PDF at",
        "https://nslegislature.ca/legislative-business/hansard-debates",
        "=" * 70,
        "",
        "",
    ])
    out_path.write_text(header + transcript)

    word_count = len(transcript.split())
    char_count = len(transcript)

    print(f"Archived {date_str}: {char_count} characters, {word_count} words -> {out_path}")

    write_github_output(
        has_content="true",
        date=date_str,
        sitting=meta["sitting"],
        pages=meta["pages"],
        word_count=word_count,
        char_count=char_count,
        archived_at=now.isoformat(timespec="seconds"),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
