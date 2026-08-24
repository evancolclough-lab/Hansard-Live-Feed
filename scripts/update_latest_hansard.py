#!/usr/bin/env python3
"""
Scrapes the NS House of Assembly Hansard listing page for the latest
*published* Hansard PDF and writes data/latest-hansard.json.

Run periodically by .github/workflows/update-latest-hansard.yml. Always
rewrites the JSON with a fresh `checkedAt`; the workflow itself decides
whether the substantive fields actually changed and, if not, discards the
run instead of committing (so the commit history only shows real updates,
not every 30-minute poll).

Two site quirks this handles (see project README for details):
  1. The top row(s) of the sitting table can be upcoming dates with no
     Hansard PDF yet (blank cell) — we walk down and take the first row
     that actually has a populated PDF link.
  2. The current Assembly/Session slug (e.g. "assembly-65-session-1")
     changes over time. Rather than hardcode it, we read it off the
     "Assembly (date)" dropdown on the Hansard index page, which the site
     itself keeps pointed at the current session. A hardcoded fallback is
     kept below in case that dropdown's markup ever changes.
"""

import json
import re
import sys
from datetime import datetime
from pathlib import Path

import requests
from bs4 import BeautifulSoup

try:
    from zoneinfo import ZoneInfo
    ATLANTIC = ZoneInfo("America/Halifax")
except Exception:  # pragma: no cover - extremely defensive
    from datetime import timezone, timedelta
    ATLANTIC = timezone(timedelta(hours=-3))

BASE = "https://nslegislature.ca"
INDEX_URL = f"{BASE}/legislative-business/hansard-debates"

# TODO: bump this if the dropdown-based auto-detection below ever fails
# (e.g. after the site's markup changes) — it's only used as a fallback.
FALLBACK_SESSION_URL = f"{BASE}/legislative-business/hansard-debates/assembly-65-session-1"

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "latest-hansard.json"

HEADERS = {
    "User-Agent": "ns-hansard-dashboard-bot/1.0 (public data updater; see repo README)"
}


def find_current_session_url(session: requests.Session) -> str:
    """Read the currently-selected option of the 'Assembly (date)' filter
    dropdown on the Hansard index page, e.g. '65-1 (2024 - 2026)', and turn
    it into the listing URL for that session."""
    resp = session.get(INDEX_URL, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    select = soup.find("select", id="edit-hansard-session-redirect")
    if select:
        selected = select.find("option", selected=True) or select.find("option")
        if selected:
            m = re.match(r"\s*(\d+)-(\d+)", selected.get_text())
            if m:
                assembly, sess = m.group(1), m.group(2)
                return f"{BASE}/legislative-business/hansard-debates/assembly-{assembly}-session-{sess}"

    print("WARNING: could not detect current session from the index dropdown; "
          "falling back to hardcoded URL — check FALLBACK_SESSION_URL is still correct.",
          file=sys.stderr)
    return FALLBACK_SESSION_URL


def scrape_latest_hansard(session: requests.Session, session_url: str) -> dict:
    resp = session.get(session_url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    table = soup.find("table", class_="views-table")
    if not table or not table.find("tbody"):
        raise RuntimeError(
            f"Could not find the sitting table at {session_url} — "
            "the site's markup may have changed (see README §CORS/scraper notes)."
        )

    rows = table.find("tbody").find_all("tr")
    for row in rows:
        cells = row.find_all("td")
        if len(cells) < 5:
            continue

        sitting = cells[0].get_text(strip=True)
        date_cell = cells[1]
        date_link = date_cell.find("a")
        date_text = (date_link.get_text(strip=True) if date_link else date_cell.get_text(strip=True))
        pages = cells[2].get_text(strip=True)
        pdf_link = cells[4].find("a")

        if not pdf_link or not pdf_link.get("href"):
            # Upcoming sitting with no Hansard published yet — keep walking down.
            continue

        pdf_url = pdf_link["href"]
        if pdf_url.startswith("/"):
            pdf_url = BASE + pdf_url

        return {
            "sitting": sitting,
            "date": date_text,
            "pages": pages,
            "pdfUrl": pdf_url,
        }

    raise RuntimeError(f"No row with a populated Hansard PDF link found at {session_url}")


def main() -> int:
    session = requests.Session()
    try:
        session_url = find_current_session_url(session)
        latest = scrape_latest_hansard(session, session_url)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    latest["checkedAt"] = datetime.now(ATLANTIC).isoformat(timespec="seconds")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(latest, indent=2) + "\n")
    print(f"Wrote {OUTPUT_PATH} :: {latest['sitting']} / {latest['date']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
