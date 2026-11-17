/* ===========================================================
   NS Hansard Live — client-side app
   - Polls StreamText's live text feed about once a second (see FEED_URL)
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

  // Which StreamText feed we read — and why it is NOT the one the original
  // brief named. StreamText exposes two:
  //   * /captions?...&language=en (the "documented" one) hands back the
  //     backlog in tiny pages of roughly 10-35 characters per request. A
  //     page opened mid-sitting — or any client that ever falls behind —
  //     crawls through the backlog one poll at a time, and because a live
  //     captioner types faster than that, it never catches up. That was
  //     the "very delayed" bug: the site fell further behind all sitting.
  //   * /text-data.ashx (the endpoint StreamText's own player uses) returns
  //     every entry after `last` in ONE response, including the whole
  //     day's backlog for last=0. Its cursor counts *entries* (the small
  //     bursts the captioner's software sends), not characters, and each
  //     entry's text is percent-encoded. last=-1 returns just the current
  //     total with no entries, which we use as a cheap probe.
  const FEED_URL = (last) =>
    `https://www.streamtext.net/text-data.ashx?event=${encodeURIComponent(EVENT_NAME)}&last=${last}`;

  // StreamText's own player polls every 500ms; we're a little gentler, and
  // slow down when nothing is being captioned.
  const POLL_LIVE_MS = 1000;
  const POLL_IDLE_MS = 3000;          // no active event, or no new text lately
  const POLL_ERROR_STEP_MS = 1000;    // errors back off linearly: 1s, 2s, 3s ...
  const POLL_ERROR_MAX_MS = 10000;    // ... capped here (same shape as StreamText's player)
  const POLL_TIMEOUT_MS = 10000;      // an ordinary poll that hangs is abandoned and retried
  const BACKLOG_TIMEOUT_MS = 45000;   // the one-off full-backlog download gets longer
  const PROBE_AFTER_MS = 30000;       // quiet this long before we double-check our cursor ...
  const PROBE_EVERY_MS = 30000;       // ... and then at most this often
  const HEAD_ENTRIES = 25;            // how many opening entries identify "which session is this"
  const PERSIST_EVERY_MS = 5000;      // localStorage writes are throttled; see schedulePersist()
  const IDLE_AFTER_MS = 75 * 1000;    // no new content for this long -> show "not sitting" instead of a stale "LIVE"
  const SESSION_BREAK = "\n\n— — —  new session  — — —\n\n";
  const BACKSPACE = "\x08";
  // v2: the saved cursor changed meaning (characters -> entries) when the
  // feed changed, so v1 saves must never be read back; see purgeLegacyStorage().
  const STORAGE_PREFIX = "nsHansardLive:v2:";
  const LEGACY_STORAGE_PREFIX = "nsHansardLive:v1:";
  const ATLANTIC_TZ = "America/Halifax";
  const REPO_URL = "https://github.com/evancolclough-lab/Hansard-Live-Feed";

  // Test mode: append ?testmode=1 to the URL to feed a simulated caption
  // stream through the exact same accumulation/render/scroll code path
  // real polling uses, instead of hitting StreamText. Useful for checking
  // the live UI (streaming, backspace corrections, auto-scroll, search,
  // download) actually works without waiting for a real sitting. Never
  // touches the real captions endpoint or the real day's localStorage
  // entry — see startTestMode() below.
  const TEST_MODE = new URLSearchParams(location.search).has("testmode");
  const TEST_CHUNK_INTERVAL_MS = 1200;
  const TEST_SCRIPT = [
    "TEST MODE — the following is simulated caption text for demonstrating this page's live-transcript features (streaming, auto-scroll, search, download). It is not a real House of Assembly sitting and represents no real proceedings. ",
    "This paragraph, and the ones after it, exist mainly to build up enough length to exercise page scrolling and the “jump to latest” button as the simulated feed streams in below. ",
    "Next, a live self-correction will be demonstrated the way a real captioner corrects a typo in real time, using the same backspace character StreamText sends for a genuine correction: ",
    "The committee reviewed the annual buudget" + BACKSPACE.repeat(7) + "budget report and a related staffing update. ",
    "Captioning corrections like that happen throughout a real sitting whenever the captioner catches a mistake, and the page above just handled one using the same code that handles real ones. ",
    "Meanwhile, here is some additional filler text simply to keep the simulated transcript growing at a realistic pace, sentence by sentence, the way real captions arrive in short bursts rather than all at once. ",
    "A second simulated speaker is recognized in this exchange and responds with a short remark of their own, continuing the flow of the demonstration text. ",
    "The Chair calls for a brief recess in this simulated proceeding before resuming with further placeholder remarks. ",
    "Proceedings resume, and the simulated speaker continues with another few sentences to further extend the visible transcript for testing purposes. ",
    "This is intentionally generic, repetitive text — the goal is exercising the UI's behaviour under a long, continuously growing transcript, not realistic debate content. ",
    "TEST MODE — that concludes this pass of the simulated script. It will now loop back to the start to keep the live demonstration running for as long as this page stays open with ?testmode=1. ",
  ];

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
    testModeBanner: document.getElementById("testModeBanner"),
  };
  el.repoLink.href = REPO_URL;

  // ---------------------------------------------------------
  // State
  // ---------------------------------------------------------
  const state = {
    dateKey: null,          // Atlantic YYYY-MM-DD this transcript belongs to
    lastPosition: 0,        // StreamText cursor: how many feed entries of the current session we've consumed
    head: [],               // raw text of the session's first HEAD_ENTRIES entries — fingerprint of "which session is this"
    needsResync: true,      // next poll must verify our cursor against the full backlog (page load, or after "no event")
    polling: false,         // a poll request is in flight (single-flight guard)
    lastProbeAt: 0,
    persistTimer: null,
    persistDirty: false,
    warnedFormats: false,
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

  // Saves written by the old /captions-based version stored a *character*
  // cursor. Reading one back as an *entry* cursor would be nonsense (and
  // those saves hold an incomplete transcript anyway), so discard them.
  function purgeLegacyStorage() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith(LEGACY_STORAGE_PREFIX)) localStorage.removeItem(key);
      }
    } catch (err) {
      /* storage unavailable — nothing to purge */
    }
  }

  function loadStateForToday() {
    purgeLegacyStorage();
    const todayKey = atlanticDateKey(new Date());
    state.dateKey = todayKey;
    try {
      const raw = localStorage.getItem(storageKey(todayKey));
      if (raw) {
        const saved = JSON.parse(raw);
        state.lastPosition = saved.lastPosition || 0;
        state.chars = saved.transcript ? Array.from(saved.transcript) : [];
        state.firstContentAt = saved.firstContentAt || null;
        state.lastContentAt = saved.lastContentAt || null;
        state.head = Array.isArray(saved.head) ? saved.head : [];
        return;
      }
    } catch (err) {
      console.warn("Could not read saved transcript from localStorage:", err);
    }
    state.lastPosition = 0;
    state.chars = [];
    state.head = [];
    state.firstContentAt = null;
    state.lastContentAt = null;
  }

  function persist() {
    try {
      localStorage.setItem(
        storageKey(state.dateKey),
        JSON.stringify({
          lastPosition: state.lastPosition,
          head: state.head,
          transcript: state.chars.join(""),
          firstContentAt: state.firstContentAt,
          lastContentAt: state.lastContentAt,
          savedAt: Date.now(),
        })
      );
    } catch (err) {
      // Quota exceeded or storage disabled — non-fatal, transcript still works this session.
      console.warn("Could not persist transcript to localStorage:", err);
    }
  }

  // Polling now runs about once a second, and persist() serialises and
  // synchronously writes the whole day's transcript, so writing on every
  // update would burn time on the main thread for no benefit. Batch writes
  // to once every few seconds, and flush when the tab is hidden or closed
  // so nothing is lost. (Test mode never calls this, so it never writes.)
  function schedulePersist() {
    state.persistDirty = true;
    if (state.persistTimer) return;
    state.persistTimer = setTimeout(flushPersist, PERSIST_EVERY_MS);
  }

  function flushPersist() {
    clearTimeout(state.persistTimer);
    state.persistTimer = null;
    if (!state.persistDirty) return;
    state.persistDirty = false;
    persist();
  }

  function resetTranscript() {
    state.lastPosition = 0;
    state.head = [];
    state.chars = [];
    state.firstContentAt = null;
    state.lastContentAt = null;
    state.matches = [];
    state.currentMatch = -1;
    state.needsResync = true;
    renderTranscript();
    persist();
  }

  function checkForDayRollover() {
    const todayKey = atlanticDateKey(new Date());
    if (todayKey !== state.dateKey) {
      // A new sitting day has begun — StreamText starts a fresh transcript
      // (and cursor) with it.
      state.dateKey = todayKey;
      resetTranscript();
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
  //
  // The cursor (state.lastPosition) is "how many feed entries of the
  // current session we've consumed". A request with last=N returns every
  // entry after the first N, plus the new total in lastPosition — so
  // last=0 is the whole backlog in one response, and last=-1 is just the
  // current total (a cheap probe). Two kinds of poll:
  //   * resync()          — downloads the full backlog and reconciles it
  //                         with what we already have. Runs on page load
  //                         and after StreamText reports "no event".
  //   * incrementalPoll() — the normal ~1s tick: just the new entries.
  // ---------------------------------------------------------

  // Entry text is percent-encoded, and "%08" is the captioner's backspace.
  // Only "basic" (plain text) entries are used: the one stream we've seen
  // sends nothing else, and mixing in another format (e.g. speech-recognition
  // text) would corrupt the transcript.
  function decodeEntries(entries) {
    let out = "";
    for (const entry of entries) {
      if (!entry || typeof entry.d !== "string") continue;
      if (entry.format && entry.format !== "basic") {
        if (!state.warnedFormats) {
          state.warnedFormats = true;
          console.warn("Ignoring feed entries in unsupported format:", entry.format);
        }
        continue;
      }
      try {
        out += decodeURIComponent(entry.d);
      } catch (err) {
        out += unescape(entry.d); // malformed %-sequence: keep what we can rather than drop the entry
      }
    }
    return out;
  }

  // One request to the feed. Resolves { status: 404 } when StreamText says
  // there's no active event (an expected, non-error state — it's what every
  // non-sitting day looks like), { status: 200, data } on success, and
  // throws on anything else, including a timeout.
  async function fetchFeed(last, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(FEED_URL(last), { cache: "no-store", signal: controller.signal });
      if (res.status === 404) return { status: 404, data: null };
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (!data || typeof data.lastPosition !== "number") throw new Error("Unexpected feed response");
      return { status: 200, data };
    } finally {
      clearTimeout(timer);
    }
  }

  // Applies a batch of entries to the transcript and advances the cursor.
  // `startIndex` is the absolute index of entries[0] within the session.
  function consumeEntries(entries, startIndex, newCursor) {
    for (let j = 0; j < entries.length; j++) {
      const idx = startIndex + j;
      const entry = entries[j];
      // Remember the session's opening entries: resync() compares them to
      // tell "same session, keep going" from "a different session".
      if (idx < HEAD_ENTRIES && state.head.length === idx && entry && typeof entry.d === "string") {
        state.head.push(entry.d);
      }
    }
    const changed = applyChunk(decodeEntries(entries));
    state.lastPosition = newCursor;
    if (changed) {
      if (!state.firstContentAt) state.firstContentAt = Date.now();
      state.lastContentAt = Date.now();
      schedulePersist();
      renderTranscript();
    }
    return changed;
  }

  function markPollSucceeded() {
    state.consecutiveErrors = 0;
    state.firstPollDone = true;
    el.loadingNotice.hidden = true;
    updateEmptyStateVisibility();
    el.lastUpdated.textContent = `Last checked: ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  }

  function nextDelay() {
    return state.connection === "live" ? POLL_LIVE_MS : POLL_IDLE_MS;
  }

  // StreamText says no event is active — i.e. not sitting. When one comes
  // back it may be a brand-new session whose numbering restarts from zero,
  // so don't trust our cursor again until resync() has checked it.
  function onNoEvent() {
    state.needsResync = true;
    markPollSucceeded();
    evaluateIdleness(true);
    return POLL_IDLE_MS;
  }

  async function resync() {
    const { status, data } = await fetchFeed(0, BACKLOG_TIMEOUT_MS);
    if (status === 404) return onNoEvent();

    const entries = Array.isArray(data.i) ? data.i : [];

    // Same session iff the backlog is at least as long as what we've
    // consumed AND its opening entries match the ones we recorded. (A new
    // session could in principle be longer than our cursor by now, which
    // is why length alone isn't enough.)
    const sameSession =
      state.lastPosition > 0 &&
      state.head.length > 0 &&
      entries.length >= state.lastPosition &&
      state.head.every((d, i) => entries[i] && entries[i].d === d);

    let startIndex;
    let fresh;
    if (sameSession) {
      startIndex = state.lastPosition;
      fresh = entries.slice(startIndex);
    } else {
      // A different (or first) session. Keep any earlier session's text on
      // the page, marked off with a divider, and take this one from the top.
      if (state.chars.length > 0) {
        applyChunk(SESSION_BREAK);
        schedulePersist();
        renderTranscript();
      }
      state.head = [];
      startIndex = 0;
      fresh = entries;
    }

    consumeEntries(fresh, startIndex, data.lastPosition);
    state.needsResync = false;
    markPollSucceeded();
    if (fresh.length > 0) setConnection("live");
    else evaluateIdleness();
    return nextDelay();
  }

  async function incrementalPoll() {
    const { status, data } = await fetchFeed(state.lastPosition, POLL_TIMEOUT_MS);
    if (status === 404) return onNoEvent();

    const entries = Array.isArray(data.i) ? data.i : [];
    if (entries.length > 0) {
      consumeEntries(entries, state.lastPosition, data.lastPosition);
      markPollSucceeded();
      setConnection("live");
      return nextDelay();
    }

    markPollSucceeded();

    // Nothing new. If it has been quiet a while, check that our cursor
    // hasn't been left ahead of a stream that restarted: the server simply
    // echoes back a cursor that's past its end, so without this check we'd
    // wait silently for a session that already restarted behind us.
    const now = Date.now();
    if (now - (state.lastContentAt || 0) > PROBE_AFTER_MS && now - state.lastProbeAt > PROBE_EVERY_MS) {
      state.lastProbeAt = now;
      const probe = await fetchFeed(-1, POLL_TIMEOUT_MS);
      if (probe.status === 404) return onNoEvent();
      if (probe.data.lastPosition < state.lastPosition) {
        state.needsResync = true;
        return 0; // resync right away
      }
    }
    evaluateIdleness();
    return nextDelay();
  }

  async function pollOnce() {
    if (state.polling) return; // already in flight (e.g. the tab just became visible mid-request)
    state.polling = true;
    clearTimeout(state.pollTimer);

    let delay;
    try {
      checkForDayRollover();
      if (!state.firstPollDone && state.chars.length === 0) el.loadingNotice.hidden = false;
      delay = await (state.needsResync ? resync() : incrementalPoll());
    } catch (err) {
      state.consecutiveErrors++;
      if (state.consecutiveErrors >= 2) setConnection("error");
      delay = Math.min(POLL_ERROR_STEP_MS * state.consecutiveErrors, POLL_ERROR_MAX_MS);
    } finally {
      state.polling = false;
    }
    state.pollTimer = setTimeout(pollOnce, delay);
  }

  function evaluateIdleness(forceIdle) {
    if (forceIdle) {
      setConnection("idle");
      return;
    }
    const quiet = !state.lastContentAt || (Date.now() - state.lastContentAt) > IDLE_AFTER_MS;
    setConnection(quiet ? "idle" : "live");
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
    // The transcript box is only given a fixed height + its own scrollbar
    // once there's text to scroll through — see .transcript-text.has-content
    // in style.css. Without this gate an empty transcript would render as a
    // tall blank box sitting right above the "No transcript yet today"
    // message instead of just that message on its own.
    el.transcript.classList.toggle("has-content", hasText);
  }

  function renderTranscript() {
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

    // Follow the live edge whenever the reader hasn't scrolled away from
    // it. That intent lives in state.autoScroll, which only the box's own
    // scroll events change (scroll up -> false, back to the bottom -> true).
    // Deliberately NOT re-derived from geometry on every render: a window
    // resize, or a phone's on-screen keyboard opening and closing, changes
    // the box's height without any scroll event, and a "am I within 60px of
    // the bottom right now?" check would then wrongly conclude the reader
    // had left and quietly stop following for good.
    if (state.chars.length > 0 && state.autoScroll) {
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
  // The transcript is its own internally-scrolling box (.has-content in
  // style.css) rather than growing the whole page, so all of this tracks
  // the box's own scrollTop/scrollHeight — not window.scrollY — and the
  // rest of the page (sidebar, footer) stays reachable via normal page
  // scroll no matter how long the transcript gets.
  // ---------------------------------------------------------
  function isNearTranscriptBottom() {
    const t = el.transcript;
    return t.scrollHeight - t.scrollTop - t.clientHeight < 60;
  }

  function scrollToLatest() {
    el.transcript.scrollTop = el.transcript.scrollHeight;
    el.jumpLatest.hidden = true;
    el.jumpLatest.classList.remove("visible");
  }

  function updateJumpButtonVisibility() {
    const shouldShow = !isNearTranscriptBottom() && state.chars.length > 0;
    el.jumpLatest.hidden = !shouldShow;
    el.jumpLatest.classList.toggle("visible", shouldShow);
  }

  el.transcript.addEventListener("scroll", () => {
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
    const header = TEST_MODE
      ? [
          "TEST MODE — SIMULATED TRANSCRIPT, NOT REAL CAPTIONS",
          "Generated by NS Hansard Live's built-in test mode (?testmode=1) to",
          "demonstrate the download feature. The text below is a scripted",
          "placeholder feed, not a real House of Assembly sitting.",
          `Captured: ${rangeStart} – ${rangeEnd} (Atlantic Time)`,
          "=".repeat(70),
          "",
          "",
        ].join("\n")
      : [
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
    const filename = `hansard-live-${TEST_MODE ? "TEST-" : ""}${atlanticStampForFilename(now)}.txt`;
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
  // Test mode
  // ---------------------------------------------------------
  function startTestMode() {
    el.testModeBanner.hidden = false;
    // Deliberately not loadStateForToday()/persist() — test mode never
    // reads or writes the real date-keyed localStorage entry, and starts
    // fresh (in memory only) every time the page loads with ?testmode=1.
    state.dateKey = "TEST";
    state.chars = [];
    state.firstContentAt = null;
    renderTranscript();
    setConnection("connecting");

    let i = 0;
    function feedNextChunk() {
      const chunk = TEST_SCRIPT[i % TEST_SCRIPT.length];
      i++;
      // Reuses the exact same accumulation function real polling calls,
      // so this is exercising the real backspace-handling code, not a
      // separate reimplementation of it.
      const changed = applyChunk(chunk);
      if (changed) {
        if (!state.firstContentAt) state.firstContentAt = Date.now();
        state.lastContentAt = Date.now();
        renderTranscript();
      }
      setConnection("live");
      updateEmptyStateVisibility();
      el.lastUpdated.textContent = `Last checked: ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} (test mode)`;
      state.pollTimer = setTimeout(feedNextChunk, TEST_CHUNK_INTERVAL_MS);
    }
    feedNextChunk();
  }

  // ---------------------------------------------------------
  // Init
  // ---------------------------------------------------------
  // Browsers throttle timers in background tabs (sometimes to once a
  // minute), which makes a tab you come back to look badly out of date.
  // Poll the moment it becomes visible again instead of waiting out a
  // throttled timer — and write any unsaved transcript to storage when it
  // is hidden or closed, since writes are batched (see schedulePersist()).
  // Real polling only: test mode neither polls StreamText nor persists.
  document.addEventListener("visibilitychange", () => {
    if (TEST_MODE) return;
    if (document.visibilityState === "hidden") flushPersist();
    else pollOnce();
  });
  window.addEventListener("pagehide", () => {
    if (!TEST_MODE) flushPersist();
  });

  function init() {
    loadLatestHansard();
    if (TEST_MODE) {
      startTestMode();
    } else {
      loadStateForToday();
      renderTranscript();
      pollOnce();
    }
  }

  init();
})();
