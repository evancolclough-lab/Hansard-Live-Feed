/* ===========================================================
   NS Hansard Live — client-side app
   - Polls StreamText's public captions endpoint every 5s
   - Reconstructs the transcript, honouring literal backspace
     (\x08) characters as "delete previous character"
   - Persists per-day progress in localStorage
   - Instant client-side search with next/prev navigation
   - .txt download, auto-scroll with "jump to latest"
   - Light/dark theme toggle
   No server, no API keys, no accounts — everything below runs
   entirely in the visitor's browser.
   =========================================================== */

(() => {
  "use strict";

  // ---------------------------------------------------------
  // Config
  // ---------------------------------------------------------
  const EVENT_NAME = "NSLegislature";
  const CAPTIONS_URL = (last) =>
    `https://www.streamtext.net/captions?event=${encodeURIComponent(EVENT_NAME)}&last=${last}&language=en`;
  const POLL_INTERVAL_MS = 5000;
  const IDLE_AFTER_MS = 75 * 1000; // no new content for this long -> show "not sitting" instead of a stale "LIVE"
  const BACKSPACE = "\x08";
  const STORAGE_PREFIX = "nsHansardLive:v1:";
  const ATLANTIC_TZ = "America/Halifax";
  const REPO_URL = "https://github.com/"; // TODO: set to this repo's URL once pushed to GitHub

  // ---------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------
  const el = {
    statusBadge: document.getElementById("statusBadge"),
    statusLabel: document.getElementById("statusLabel"),
    lastUpdated: document.getElementById("lastUpdated"),
    themeToggle: document.getElementById("themeToggle"),
    themeToggleIcon: document.getElementById("themeToggleIcon"),
    searchInput: document.getElementById("searchInput"),
    searchCount: document.getElementById("searchCount"),
    searchPrev: document.getElementById("searchPrev"),
    searchNext: document.getElementById("searchNext"),
    downloadBtn: document.getElementById("downloadBtn"),
    transcript: document.getElementById("transcript"),
    loadingNotice: document.getElementById("loadingNotice"),
    emptyState: document.getElementById("emptyState"),
    jumpLatest: document.getElementById("jumpLatest"),
    hansardCardBody: document.getElementById("hansardCardBody"),
    repoLink: document.getElementById("repoLink"),
  };
  el.repoLink.href = REPO_URL;

  // ---------------------------------------------------------
  // State
  // ---------------------------------------------------------
  const state = {
    dateKey: null,          // Atlantic YYYY-MM-DD this transcript belongs to
    lastPosition: 0,        // StreamText cursor
    chars: [],              // accumulated transcript, as an array of characters (fast push/pop for backspace handling)
    firstContentAt: null,   // ms epoch — when today's transcript first received text
    lastContentAt: null,    // ms epoch — last time new (non-empty) content arrived
    connection: "connecting", // 'connecting' | 'live' | 'idle' | 'error'
    consecutiveErrors: 0,
    autoScroll: true,
    searchQuery: "",
    matches: [],             // character offsets of each match
    currentMatch: -1,
    pollTimer: null,
    firstPollDone: false,
    firstRenderDone: false,
  };

  // ---------------------------------------------------------
  // Atlantic time helpers
  // ---------------------------------------------------------
  function atlanticDateKey(date) {
    // en-CA gives YYYY-MM-DD directly
    return new Intl.DateTimeFormat("en-CA", { timeZone: ATLANTIC_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }

  function atlanticParts(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: ATLANTIC_TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t).value;
    return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
  }

  function atlanticStampForFilename(date) {
    const p = atlanticParts(date);
    return `${p.year}-${p.month}-${p.day}_${p.hour}${p.minute}`;
  }

  function atlanticReadable(date) {
    const p = atlanticParts(date);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} AT`;
  }

  // ---------------------------------------------------------
  // Persistence (localStorage, keyed by Atlantic date)
  // ---------------------------------------------------------
  function storageKey(dateKey) {
    return STORAGE_PREFIX + dateKey;
  }

  function loadStateForToday() {
    const todayKey = atlanticDateKey(new Date());
    state.dateKey = todayKey;
    try {
      const raw = localStorage.getItem(storageKey(todayKey));
      if (raw) {
        const saved = JSON.parse(raw);
        state.lastPosition = saved.lastPosition || 0;
        state.chars = saved.transcript ? Array.from(saved.transcript) : [];
        state.firstContentAt = saved.firstContentAt || null;
        return;
      }
    } catch (err) {
      console.warn("Could not read saved transcript from localStorage:", err);
    }
    state.lastPosition = 0;
    state.chars = [];
    state.firstContentAt = null;
  }

  function persist() {
    try {
      localStorage.setItem(
        storageKey(state.dateKey),
        JSON.stringify({
          lastPosition: state.lastPosition,
          transcript: state.chars.join(""),
          firstContentAt: state.firstContentAt,
          savedAt: Date.now(),
        })
      );
    } catch (err) {
      // Quota exceeded or storage disabled — non-fatal, transcript still works this session.
      console.warn("Could not persist transcript to localStorage:", err);
    }
  }

  function checkForDayRollover() {
    const todayKey = atlanticDateKey(new Date());
    if (todayKey !== state.dateKey) {
      // A new sitting day has begun — StreamText's "last" cursor resets with it.
      state.dateKey = todayKey;
      state.lastPosition = 0;
      state.chars = [];
      state.firstContentAt = null;
      state.matches = [];
      state.currentMatch = -1;
      renderTranscript();
      persist();
    }
  }

  // ---------------------------------------------------------
  // Backspace-aware accumulation
  // ---------------------------------------------------------
  function applyChunk(content) {
    let changed = false;
    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      if (ch === BACKSPACE) {
        if (state.chars.length > 0) {
          state.chars.pop();
          changed = true;
        }
      } else {
        state.chars.push(ch);
        changed = true;
      }
    }
    return changed;
  }

  // ---------------------------------------------------------
  // Polling
  // ---------------------------------------------------------
  async function pollOnce() {
    checkForDayRollover();

    const isFirstPoll = !state.firstPollDone;
    if (isFirstPoll && state.lastPosition === 0) {
      el.loadingNotice.hidden = false;
    }

    let data;
    try {
      const res = await fetch(CAPTIONS_URL(state.lastPosition), { cache: "no-store" });
      // StreamText returns JSON even on a 404 ("event not found" / idle day),
      // so we always try to parse the body rather than branching on status.
      data = await res.json();
    } catch (err) {
      state.consecutiveErrors++;
      if (state.consecutiveErrors >= 2) setConnection("error");
      scheduleNextPoll();
      return;
    }

    state.consecutiveErrors = 0;
    state.firstPollDone = true;
    el.loadingNotice.hidden = true;

    const gotValidCursor = typeof data.lastPosition === "number" && data.lastPosition >= 0;

    if (gotValidCursor) {
      if (data.content) {
        const changed = applyChunk(data.content);
        state.lastPosition = data.lastPosition;
        if (changed) {
          if (!state.firstContentAt) state.firstContentAt = Date.now();
          state.lastContentAt = Date.now();
          persist();
          renderTranscript();
        }
        setConnection("live");
      } else {
        state.lastPosition = data.lastPosition;
        evaluateIdleness();
      }
    } else {
      // lastPosition -1 / missing => no such event right now => not sitting
      evaluateIdleness(true);
    }

    updateEmptyStateVisibility();
    el.lastUpdated.textContent = `Last checked: ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    scheduleNextPoll();
  }

  function evaluateIdleness(forceIdle) {
    if (forceIdle) {
      setConnection("idle");
      return;
    }
    const quiet = !state.lastContentAt || (Date.now() - state.lastContentAt) > IDLE_AFTER_MS;
    setConnection(quiet ? "idle" : "live");
  }

  function scheduleNextPoll() {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
  }

  // ---------------------------------------------------------
  // Status UI
  // ---------------------------------------------------------
  function setConnection(status) {
    if (state.connection === status) return;
    state.connection = status;
    el.statusBadge.className = "status-badge status-" + status;
    const labels = {
      connecting: "Connecting…",
      live: "LIVE",
      idle: "Not currently sitting",
      error: "Connection issue — retrying…",
    };
    el.statusLabel.textContent = labels[status] || status;
  }

  // ---------------------------------------------------------
  // Rendering + search
  // ---------------------------------------------------------
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function findMatches(text, query) {
    if (!query) return [];
    const hay = text.toLowerCase();
    const needle = query.toLowerCase();
    const out = [];
    let idx = 0;
    while (true) {
      const found = hay.indexOf(needle, idx);
      if (found === -1) break;
      out.push(found);
      idx = found + needle.length;
    }
    return out;
  }

  function updateEmptyStateVisibility() {
    const hasText = state.chars.length > 0;
    el.emptyState.style.display = hasText ? "none" : (state.firstPollDone ? "block" : "none");
  }

  function renderTranscript() {
    // On the very first paint the transcript element is still empty, so the
    // "am I near the bottom" heuristic is meaningless (a near-empty page is
    // trivially "near its own bottom"). Treat first paint as "was at
    // bottom" so a restored/backfilled transcript opens at the latest text,
    // then let the real heuristic take over from the second render on.
    const wasNearBottom = state.firstRenderDone ? isNearTranscriptBottom() : true;
    state.firstRenderDone = true;
    const text = state.chars.join("");

    updateEmptyStateVisibility();

    if (!state.searchQuery) {
      el.transcript.textContent = text;
      state.matches = [];
      state.currentMatch = -1;
      updateSearchCountUI();
    } else {
      state.matches = findMatches(text, state.searchQuery);
      if (state.currentMatch >= state.matches.length) state.currentMatch = state.matches.length - 1;
      const qLen = state.searchQuery.length;
      let html = "";
      let cursor = 0;
      state.matches.forEach((pos, i) => {
        html += escapeHtml(text.slice(cursor, pos));
        const cls = i === state.currentMatch ? "current-hit" : "";
        html += `<mark class="${cls}" data-idx="${i}">${escapeHtml(text.slice(pos, pos + qLen))}</mark>`;
        cursor = pos + qLen;
      });
      html += escapeHtml(text.slice(cursor));
      el.transcript.innerHTML = html;
      updateSearchCountUI();
    }

    if (state.autoScroll && wasNearBottom) {
      scrollToLatest();
    } else {
      updateJumpButtonVisibility();
    }
  }

  function updateSearchCountUI() {
    if (!state.searchQuery) {
      el.searchCount.textContent = "";
      el.searchPrev.disabled = true;
      el.searchNext.disabled = true;
      return;
    }
    const total = state.matches.length;
    if (total === 0) {
      el.searchCount.textContent = "0 matches";
      el.searchPrev.disabled = true;
      el.searchNext.disabled = true;
    } else {
      const shown = state.currentMatch >= 0 ? state.currentMatch + 1 : 0;
      el.searchCount.textContent = `${shown || "–"} / ${total}`;
      el.searchPrev.disabled = false;
      el.searchNext.disabled = false;
    }
  }

  function goToMatch(index) {
    if (state.matches.length === 0) return;
    const total = state.matches.length;
    state.currentMatch = ((index % total) + total) % total;
    renderTranscript();
    const target = el.transcript.querySelector(`mark[data-idx="${state.currentMatch}"]`);
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  // ---------------------------------------------------------
  // Auto-scroll / jump to latest
  // ---------------------------------------------------------
  function isNearTranscriptBottom() {
    const rect = el.transcript.getBoundingClientRect();
    const bottomOfTranscript = window.scrollY + rect.bottom;
    const nearEnough = window.scrollY + window.innerHeight >= bottomOfTranscript - 60;
    return nearEnough;
  }

  function scrollToLatest() {
    const rect = el.transcript.getBoundingClientRect();
    const targetY = window.scrollY + rect.bottom - window.innerHeight + 40;
    window.scrollTo({ top: Math.max(targetY, 0), behavior: "auto" });
    el.jumpLatest.hidden = true;
    el.jumpLatest.classList.remove("visible");
  }

  function updateJumpButtonVisibility() {
    const shouldShow = !isNearTranscriptBottom() && state.chars.length > 0;
    el.jumpLatest.hidden = !shouldShow;
    el.jumpLatest.classList.toggle("visible", shouldShow);
  }

  window.addEventListener("scroll", () => {
    state.autoScroll = isNearTranscriptBottom();
    updateJumpButtonVisibility();
  }, { passive: true });

  el.jumpLatest.addEventListener("click", () => {
    state.autoScroll = true;
    scrollToLatest();
  });

  // ---------------------------------------------------------
  // Search UI wiring
  // ---------------------------------------------------------
  let searchDebounce = null;
  el.searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.searchQuery = el.searchInput.value.trim();
      state.currentMatch = state.searchQuery ? 0 : -1;
      renderTranscript();
      if (state.searchQuery && state.matches.length) {
        goToMatch(0);
      }
    }, 150);
  });

  el.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goToMatch(state.currentMatch - 1);
      else goToMatch(state.currentMatch + 1);
    }
  });
  el.searchNext.addEventListener("click", () => goToMatch(state.currentMatch + 1));
  el.searchPrev.addEventListener("click", () => goToMatch(state.currentMatch - 1));

  // ---------------------------------------------------------
  // Download .txt
  // ---------------------------------------------------------
  el.downloadBtn.addEventListener("click", () => {
    const now = new Date();
    const rangeStart = state.firstContentAt ? atlanticReadable(new Date(state.firstContentAt)) : "unknown";
    const rangeEnd = atlanticReadable(now);
    const header = [
      "NOVA SCOTIA HOUSE OF ASSEMBLY — UNOFFICIAL LIVE TRANSCRIPT",
      `Source: StreamText.net live captioning feed (event="${EVENT_NAME}")`,
      "  https://www.streamtext.net/player?event=" + EVENT_NAME,
      `Captured: ${rangeStart} – ${rangeEnd} (Atlantic Time)`,
      "",
      "DISCLAIMER: This is an unofficial, real-time, auto/captioner-generated",
      "transcript and may contain errors, omissions, or misattributions. It is",
      "NOT the official record. The official record is the published Hansard",
      "PDF at https://nslegislature.ca/legislative-business/hansard-debates",
      "=".repeat(70),
      "",
      "",
    ].join("\n");

    const blob = new Blob([header + state.chars.join("")], { type: "text/plain;charset=utf-8" });
    const filename = `hansard-live-${atlanticStampForFilename(now)}.txt`;
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // ---------------------------------------------------------
  // Theme toggle
  // ---------------------------------------------------------
  const THEME_KEY = "nsHansardLive:theme";
  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    const isDark = theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    el.themeToggleIcon.textContent = isDark ? "☀️" : "🌙";
  }

  function currentEffectiveTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  el.themeToggle.addEventListener("click", () => {
    const next = currentEffectiveTheme() === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });

  applyTheme(localStorage.getItem(THEME_KEY));

  // ---------------------------------------------------------
  // Latest Hansard PDF card
  // ---------------------------------------------------------
  async function loadLatestHansard() {
    try {
      const res = await fetch("data/latest-hansard.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      renderHansardCard(data);
    } catch (err) {
      el.hansardCardBody.innerHTML = `<p class="muted">Couldn&rsquo;t load the latest Hansard reference right now. You can browse them directly on the
        <a href="https://nslegislature.ca/legislative-business/hansard-debates" target="_blank" rel="noopener">Legislature&rsquo;s website</a>.</p>`;
    }
  }

  function renderHansardCard(data) {
    if (!data || !data.pdfUrl) {
      el.hansardCardBody.innerHTML = `<p class="muted">No Hansard PDF on file yet.</p>`;
      return;
    }
    const checked = data.checkedAt ? new Date(data.checkedAt) : null;
    el.hansardCardBody.innerHTML = `
      <dl>
        <dt>Sitting</dt><dd>${escapeHtml(data.sitting || "—")}</dd>
        <dt>Date</dt><dd>${escapeHtml(data.date || "—")}</dd>
        <dt>Pages</dt><dd>${escapeHtml(data.pages || "—")}</dd>
      </dl>
      <a class="pdf-link" href="${encodeURI(data.pdfUrl)}" target="_blank" rel="noopener">📄 Open Hansard PDF</a>
      ${checked ? `<p class="checked-at">Checked ${checked.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p>` : ""}
    `;
  }

  // ---------------------------------------------------------
  // Init
  // ---------------------------------------------------------
  function init() {
    loadStateForToday();
    renderTranscript();
    loadLatestHansard();
    pollOnce();
  }

  init();
})();
