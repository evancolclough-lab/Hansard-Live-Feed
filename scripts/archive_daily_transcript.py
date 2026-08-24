#!/usr/bin/env python3
"""
Fetches the *entire* current day's live-caption transcript from StreamText
in one shot (last=0 returns full backfill for the day, per StreamText's own
documented behaviour — see README's CORS/verification notes), and writes it
to transcripts/<date>.txt for the workflow to commit.

Run once nightly by .github/workflows/archive-daily-transcript.yml, well
after the House would realistically have risen for the day. On a day with
no sitting, this exits cleanly without writing anything or touching the
Sheet — see GITHUB_OUTPUT's has_content flag, which the workflow checks
before its commit/notify steps.

This script does NOT talk to Google Sheets directly and does NOT commit to
git — see the workflow file for that. It only: fetches, reconstructs,
writes the local file, and reports outputs for later workflow steps.
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path

import requests

try:
    from zoneinfo import ZoneInfo
    ATLANTIC = ZoneInfo("America/Halifax")
except Exception:  # pragma: no cover
    from datetime import timezone, timedelta
    ATLANTIC = timezone(timedelta(hours=-3))

EVENT_NAME = "NSLegislature"
CAPTIONS_URL = f"https://www.streamtext.net/captions?event={EVENT_NAME}&last=0&language=en"
BACKSPACE = "\x08"

REPO_ROOT = Path(__file__).resolve().parent.parent
TRANSCRIPTS_DIR = REPO_ROOT / "transcripts"
LATEST_HANSARD_PATH = REPO_ROOT / "data" / "latest-hansard.json"

HEADERS = {
    "User-Agent": "ns-hansard-dashboard-bot/1.0 (public data updater; see repo README)"
}


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


def fetch_full_day_transcript() -> tuple[str, bool]:
    """Returns (transcript_text, had_content). had_content is False on a
    non-sitting day (StreamText returns a negative/absent lastPosition or
    literally no content for the event that day)."""
    resp = requests.get(CAPTIONS_URL, headers=HEADERS, timeout=30)
    # StreamText returns JSON even on a 404 ("event not found" / idle day),
    # so parse the body regardless of status rather than branching on it —
    # matches the frontend's own handling.
    try:
        data = resp.json()
    except (json.JSONDecodeError, ValueError):
        return "", False

    last_position = data.get("lastPosition")
    if not isinstance(last_position, (int, float)) or last_position < 0:
        return "", False

    content = data.get("content") or ""
    transcript = apply_backspaces(content)
    return transcript, len(transcript.strip()) > 0


def best_effort_sitting_metadata(date_str: str) -> dict:
    """If data/latest-hansard.json happens to already reference today's
    sitting (it won't, usually — the official PDF is typically published
    days after the sitting, not same-day), use its sitting/pages fields.
    Otherwise leave them blank; not essential, just a nice-to-have."""
    if not LATEST_HANSARD_PATH.exists():
        return {"sitting": "", "pages": ""}
    try:
        data = json.loads(LATEST_HANSARD_PATH.read_text())
    except json.JSONDecodeError:
        return {"sitting": "", "pages": ""}
    # data["date"] looks like "2026-Apr-9" — not the same format as our
    # YYYY-MM-DD date_str, and matching them reliably isn't worth the
    # complexity here given it'll rarely line up same-day anyway.
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

    transcript, had_content = fetch_full_day_transcript()

    if not had_content:
        print(f"No transcript content for {date_str} — House likely wasn't sitting. Skipping.")
        write_github_output(has_content="false")
        return 0

    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = TRANSCRIPTS_DIR / f"{date_str}.txt"

    meta = best_effort_sitting_metadata(date_str)
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
