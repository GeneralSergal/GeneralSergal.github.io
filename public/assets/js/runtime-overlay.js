/* ============================================================
   ORP v3.0 — Clinical Core: Global Runtime Overlay
   runtime-overlay.js

   Drop <script src="assets/js/runtime-overlay.js"></script>
   in every page AFTER main.js. This file:
     1. Injects the NESS HUD into the DOM on every page
     2. Binds scroll + click entropy to the NESS engine
     3. Persists cumulative session entropy via sessionStorage
     4. Manages Warden state across the whole site

   PATCH LOG (v3.0.1):
     HIGH-2  — will-change: width removed from #cc-panel; width is a layout
               property, not GPU-compositable. was: will-change:width,opacity
               now: will-change:opacity only.
     HIGH-3  — .entropia-sigil root block removed from injected CSS. Was
               conflicting with entropia-sigil.css's own will-change:filter +
               contain:layout style, and transition:transform fought the JS float.
               .high-drift kept but scoped to :not(.entropia-sigil--hero-bg).
     MEDIUM-1— rAF loop early-exit added: returns immediately when neither
               decay (900ms) nor sigil-sync (800ms) window has elapsed.
     MEDIUM-2— _syncAsciiPanel uses _getSigils()[0] instead of cold querySelector.
     MEDIUM-3— _syncAsciiPanel() calls guarded behind if(_dom().asciiPanel).
     MEDIUM-4— addLog() replaced full O(n) renderLog() rebuild with single
               prepend + tail trim. renderLog() removed.
     MEDIUM-5— sessionStorage.setItem debounced to max 1 write/second via
               _debouncedSave(); pagehide flushes any pending write.
     LOW-1   — pagehide listener cancels rAF handle and clears debounce timer.
     LOW-3   — pagehide listener disconnects menuObserver.

   PATCH LOG (v3.0.2 — SHS STATE MACHINE):
     SHS-1   — calcSHS() replaced with a full monotonic hysteresis state
               machine. States: GREEN → YELLOW → ORANGE → RED → BLACK.
               BLACK is absorbing — no automatic recovery; only manual
               Architect reset (cc-reset) can exit. All other recovery
               is stepwise and requires sustained low drift for ~8000ms.
               Persistent machine state lives in window._orpSHSState so
               the rAF-stateless loop can read across frames without closure
               mutation. Keeps full backward compat with updateSigilFromSHS.
     SHS-2   — Real performance telemetry wired into drift calculation.
               _rafLoop now measures delta-time and frame rate on every tick.
               Slow frames (> 33ms, i.e. < 30fps) add real drift pressure on
               top of the existing synthetic ΔS + ρ inputs. This means the
               system genuinely reflects GPU/CPU load, not just simulated
               entropy. Telemetry exposed on window._orpSHSState for audit.
     SHS-3   — Event latency telemetry added: scroll and click listeners
               stamp performance.now() at dispatch; _rafLoop reads the gap
               (rAF timestamp − last event timestamp) as a jitter signal.
               High jitter (> 80ms) applies a small additional drift push.
     SHS-4   — NUCLEAR display state added for BLACK SHS: tab pill and metric
               val receive class "nuclear" (dark/pulsing red). CSS rule added
               to injected styles.

   PATCH LOG (v3.0.3 — Pre-deploy fixes):
     BUG-1   — MutationObserver target corrected. menuObserver was watching
               document.body for 'mobile-menu-open' class, but main.js only
               ever sets 'menu-open' on nav#main-nav — never on body. Observer
               now watches BOTH nodes: body (for any body class changes from
               future consumers) AND navElement (for main.js's actual 'menu-open'
               toggle). Trigger logic updated to check nav.menu-open as primary
               signal. CSS cc-hidden selectors unchanged (defensive coverage).
     BUG-2   — injectDelta() now gates on BLACK state. Previously, scroll and
               click listeners called injectDelta() unconditionally, which
               mutated state.rho and state.warden directly even in BLACK state
               (decay() froze them, but injectDelta ran first, corrupting values
               before decay could clamp). Gate added at top of injectDelta:
               returns immediately when machine is BLACK, but still timestamps
               the event for jitter telemetry (SHS-3 signal preserved).
     BUG-3   — Entropy injection (scroll/click → injectDelta) now severed in
               BLACK state per spec ("rAF + listeners severed"). rAF itself
               continues at reduced cadence (sigil-sync only, decay disabled)
               so the NUCLEAR display state remains live and the sigil keeps
               reacting. This is the correct interpretation: the entropy INPUT
               pipeline is severed; the OUTPUT/display pipeline stays hot.
   ============================================================ */

(() => {
  "use strict";

  /* ── Guard: only one instance per page ─────────────────── */
  if (document.getElementById("cc-overlay")) return;

  /* ── Session entropy persistence ───────────────────────── */
  const SS_KEY            = "orp_session_entropy";
  const loadSessionEntropy = () => parseFloat(sessionStorage.getItem(SS_KEY) || "0");
  const saveSessionEntropy = (v) => sessionStorage.setItem(SS_KEY, String(v));

  /* MEDIUM-5 PATCH: debounced sessionStorage write — max 1 write/second. */
  let _saveTimer = null;
  function _debouncedSave() {
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      saveSessionEntropy(state.sessionEntropy);
    }, 1000);
  }

  /* ── State ──────────────────────────────────────────────── */
  const state = {
    deltaS:         0,
    rho:            100,
    warden:         0,
    wardenState:    "DORMANT",
    shs:            "GREEN",
    logEntries:     [],
    sessionEntropy: loadSessionEntropy(),
    panelOpen:      false,
    _rafHandle:     null,
  };

  /* ──────────────────────────────────────────────────────────
     SHS-1: Persistent machine state — lives outside the rAF
     closure so the stateless loop can read it each frame.

     States (monotonic degradation, stepwise recovery):
       GREEN  → rho ≥ 75, no sustained drift
       YELLOW → rho [55–75) or brief drift
       ORANGE → rho [35–55) or moderate sustained drift
       RED    → rho [15–35) or high sustained drift
       BLACK  → rho < 15 OR manual injection; absorbing terminal

     Degradation: immediate on threshold crossing.
     Recovery:    stepwise, one level at a time.
                  Requires stabilityCounter ≥ STABILITY_TICKS consecutive
                  low-drift ticks before stepping up.
     BLACK exits: only via Architect reset (cc-reset button).
  ─────────────────────────────────────────────────────────── */
  const SHS_STATES  = ["GREEN", "YELLOW", "ORANGE", "RED", "BLACK"];
  const STABILITY_TICKS = 8;   // 8 × ~1 second ticks ≈ 8000ms sustained stability
  const PERF_DRIFT_SCALE = 0.08; // max drift addition per slow frame tick

  window._orpSHSState = {
    currentState:      "GREEN",
    lastTransitionTs:  0,
    stabilityCounter:  0,
    // SHS-2: real performance telemetry, updated every rAF tick
    lastFrameDelta:    0,    // ms between last two rAF timestamps
    frameRate:         60,   // smoothed fps estimate
    perfDriftPressure: 0,    // [0,1] extra drift from slow frames
    // SHS-3: event latency telemetry
    lastScrollTs:      0,    // performance.now() of last scroll event
    lastClickTs:       0,    // performance.now() of last click event
    eventJitter:       0,    // ms gap between last event and rAF read
    jitterDrift:       0,    // [0,1] extra drift from high event jitter
  };

  /* ── Helpers ────────────────────────────────────────────── */
  const clamp  = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmt4   = n => n.toFixed(4);
  const fmt1   = n => n.toFixed(1);
  const nowStr = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

  /* ── Cached DOM refs (populated after buildOverlay) ────── */
  let _domCache = null;

  /* ── Cached sigil NodeList ──────────────────────────────── */
  let _sigilCache = null;
  function _getSigils() {
    return _sigilCache || (_sigilCache = document.querySelectorAll('.entropia-sigil'));
  }

  function _dom() {
    if (_domCache) return _domCache;
    const g = id => document.getElementById(id);
    _domCache = {
      overlay:       g("cc-overlay"),
      tab:           g("cc-tab"),
      panel:         g("cc-panel"),
      dot:           g("cc-tab-dot"),
      pill:          g("cc-tab-shs"),
      ds:            g("cc-ds"),
      rho:           g("cc-rho"),
      rhoBar:        g("cc-rho-bar"),
      rhoPct:        g("cc-rho-pct"),
      shs:           g("cc-shs"),
      wpct:          g("cc-wpct"),
      wBar:          g("cc-w-bar"),
      wPct:          g("cc-w-pct"),
      wardenIcon:    g("cc-warden-icon"),
      wardenTitle:   g("cc-warden-title"),
      wardenDesc:    g("cc-warden-desc"),
      wardenBadge:   g("cc-warden-badge"),
      wardenRow:     g("cc-warden-row"),
      sessionVal:    g("cc-session-val"),
      pageLabel:     g("cc-page-label"),
      log:           g("cc-log"),
      asciiPanel:    document.querySelector('.ascii-core-panel'),
    };
    return _domCache;
  }

  /* ── Inject overlay HTML ────────────────────────────────── */
  function buildOverlay() {
    const isORPContext = window.location.pathname.includes('/ORP');
    const runtimeUrl  = isORPContext ? 'runtime.html' : 'https://generalsergal.github.io/ORP/runtime.html';
    const linkTarget  = isORPContext ? '' : ' target="_blank" rel="noopener noreferrer"';

    const div = document.createElement("div");
    div.id = "cc-overlay";
    div.setAttribute("aria-label", "Clinical Core NESS Overlay");
    div.innerHTML = `
      <button id="cc-tab" aria-label="Toggle Clinical Core panel" aria-expanded="false">
        <span id="cc-tab-dot" class="cc-dot"></span>
        <span id="cc-tab-label">NESS</span>
        <span id="cc-tab-shs" class="cc-shs-pill green">GREEN</span>
      </button>

      <div id="cc-panel" aria-hidden="true">
        <div class="cc-panel-inner">

          <div class="cc-panel-header">
            <div class="cc-panel-title">
              <span class="cc-dot orange"></span>
              CLINICAL CORE // NESS
            </div>
            <div class="cc-panel-sub" id="cc-page-label">—</div>
          </div>

          <div class="cc-metrics">
            <div class="cc-metric">
              <div class="cc-metric-label">ΔS</div>
              <div class="cc-metric-val" id="cc-ds">0.0000</div>
            </div>
            <div class="cc-metric">
              <div class="cc-metric-label">ρ(x)</div>
              <div class="cc-metric-val cyan" id="cc-rho">100.0</div>
            </div>
            <div class="cc-metric">
              <div class="cc-metric-label">SHS</div>
              <div class="cc-metric-val green" id="cc-shs">GREEN</div>
            </div>
            <div class="cc-metric">
              <div class="cc-metric-label">W%</div>
              <div class="cc-metric-val" id="cc-wpct">0%</div>
            </div>
          </div>

          <div class="cc-bar-row">
            <span class="cc-bar-label">INTEGRITY</span>
            <div class="cc-bar-track">
              <div class="cc-bar-fill" id="cc-rho-bar"></div>
            </div>
            <span class="cc-bar-pct" id="cc-rho-pct">100%</span>
          </div>

          <div class="cc-bar-row">
            <span class="cc-bar-label">WARDEN</span>
            <div class="cc-bar-track">
              <div class="cc-bar-fill danger" id="cc-w-bar"></div>
            </div>
            <span class="cc-bar-pct" id="cc-w-pct">0%</span>
          </div>

          <div id="cc-warden-row" class="cc-warden-row">
            <span id="cc-warden-icon" class="cc-warden-icon">⬡</span>
            <div class="cc-warden-info">
              <div id="cc-warden-title" class="cc-warden-title">Warden — DORMANT</div>
              <div id="cc-warden-desc"  class="cc-warden-desc">No drift detected. Epistemic isolation nominal.</div>
            </div>
            <span id="cc-warden-badge" class="cc-badge dormant">DORMANT</span>
          </div>

          <div class="cc-session-row">
            <span class="cc-bar-label">SESSION ΔΣ</span>
            <span id="cc-session-val" class="cc-session-val">0.0000</span>
          </div>

          <div class="cc-log" id="cc-log"></div>

          <div class="cc-controls">
            <button class="cc-btn" id="cc-inject">[ INJECT ΔS ]</button>
            <button class="cc-btn" id="cc-reset">[ RESET ]</button>
            <a href="${runtimeUrl}" class="cc-btn cc-btn-link"${linkTarget}>[ FULL CONSOLE ]</a>
          </div>

        </div>
      </div>
    `;
    document.body.appendChild(div);
  }

  /* ── Inject CSS ─────────────────────────────────────────── */
  function buildStyles() {
    const style = document.createElement("style");
    style.id = "cc-styles";
    style.textContent = `
      #cc-overlay {
        position: fixed;
        bottom: 24px;
        left: 24px;
        z-index: 9995;
        display: flex;
        flex-direction: row;
        align-items: flex-end;
        gap: 12px;
        pointer-events: none;
        font-family: "Oxanium", "Space Grotesk", sans-serif;
        will-change: transform;
        contain: layout style paint;
        transform: translateZ(0);
        transition: opacity 180ms ease, visibility 180ms ease, transform 180ms ease;
      }
      #cc-overlay * {
        pointer-events: auto;
        box-sizing: border-box;
      }
      #cc-overlay #cc-panel:not(.open),
      #cc-overlay #cc-panel:not(.open) * {
        pointer-events: none !important;
      }

      #cc-tab {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 7px 14px;
        background: rgba(15,18,23,0.92);
        border: 1px solid rgba(221,17,17,0.25);
        border-radius: 9999px;
        color: #dce2eb;
        font-family: "Oxanium", sans-serif;
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.1em;
        cursor: pointer;
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        transition: transform 0.25s cubic-bezier(0.23,1,0.32,1),
                    border-color 0.25s ease;
        will-change: transform;
        box-shadow: 0 4px 20px rgba(0,0,0,0.6);
        margin-top: 0;
        align-self: flex-end;
      }
      #cc-tab:hover {
        transform: translateY(-2px) scale(1.02);
        border-color: rgba(255,102,0,0.5);
      }

      .cc-dot {
        display: inline-block;
        width: 7px; height: 7px;
        border-radius: 50%;
        background: #3fb950;
        flex-shrink: 0;
        position: relative;
        animation: ccDotFade 2s ease infinite;
        will-change: opacity;
      }
      .cc-dot.orange { background: #ff6600; animation-delay: 0.4s; }
      .cc-dot.red    { background: #ff3333; animation-delay: 0.8s; }

      .cc-dot::after {
        content: "";
        position: absolute;
        inset: -4px;
        border-radius: 50%;
        background: currentColor;
        opacity: 0;
        transform: scale(0.6);
        animation: ccPulseRing 2s ease infinite;
        will-change: transform, opacity;
      }
      .cc-dot.orange::after { background: #ff6600; }
      .cc-dot.red::after    { background: #ff3333; }

      @keyframes ccDotFade {
        0%,100% { opacity: 1; }
        50%     { opacity: 0.6; }
      }
      @keyframes ccPulseRing {
        0%   { transform: scale(0.6); opacity: 0.5; }
        70%  { transform: scale(2.2); opacity: 0; }
        100% { transform: scale(2.2); opacity: 0; }
      }

      .cc-shs-pill {
        font-size: 0.6rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        padding: 2px 7px;
        border-radius: 999px;
        border: 1px solid;
      }
      .cc-shs-pill.green  { color: #3fb950; border-color: rgba(63,185,80,0.3);   background: rgba(63,185,80,0.08); }
      .cc-shs-pill.yellow { color: #ffcc00; border-color: rgba(255,204,0,0.3);   background: rgba(255,204,0,0.08); }
      .cc-shs-pill.amber  { color: #ff8833; border-color: rgba(255,136,51,0.3);  background: rgba(255,136,51,0.08); }
      .cc-shs-pill.orange { color: #ff8833; border-color: rgba(255,136,51,0.3);  background: rgba(255,136,51,0.08); }
      .cc-shs-pill.red    { color: #ff3333; border-color: rgba(221,17,17,0.35);  background: rgba(221,17,17,0.1); }
      /* SHS-4: NUCLEAR/BLACK display state — pulsing terminal red */
      .cc-shs-pill.nuclear,
      .cc-shs-pill.black {
        color: #ff0000;
        border-color: rgba(255,0,0,0.6);
        background: rgba(255,0,0,0.18);
        animation: ccNuclearPulse 0.6s ease-in-out infinite alternate;
      }
      @keyframes ccNuclearPulse {
        from { box-shadow: 0 0 4px rgba(255,0,0,0.4); }
        to   { box-shadow: 0 0 12px rgba(255,0,0,0.8), 0 0 24px rgba(255,0,0,0.3); }
      }

      #cc-panel {
        width: 0;
        overflow: hidden;
        opacity: 0;
        transition: width 0.42s cubic-bezier(0.23,1,0.32,1),
                    opacity 0.25s ease;
        will-change: opacity; /* HIGH-2 PATCH: 'width' removed — layout prop, not GPU-compositable */
        pointer-events: none;
        align-self: flex-end;
      }
      #cc-panel.open {
        width: 340px;
        opacity: 1;
        pointer-events: auto;
      }
      .cc-panel-inner {
        background: rgba(15,18,23,0.95);
        border: 1px solid rgba(221,17,17,0.2);
        border-radius: 18px;
        padding: 18px;
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        box-shadow: 0 16px 48px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,102,0,0.04);
        width: 320px;
      }

      .cc-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid rgba(221,17,17,0.1);
        padding-bottom: 12px;
        margin-bottom: 14px;
      }
      .cc-panel-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.78rem;
        font-weight: 700;
        color: #f0f4f9;
        letter-spacing: 0.08em;
      }
      .cc-panel-sub {
        font-family: monospace;
        font-size: 0.62rem;
        color: rgba(138,149,165,0.6);
        letter-spacing: 0.06em;
        max-width: 130px;
        text-align: right;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .cc-metrics {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
        margin-bottom: 14px;
      }
      .cc-metric {
        background: rgba(6,8,11,0.5);
        border: 1px solid rgba(221,17,17,0.08);
        border-radius: 10px;
        padding: 8px 6px;
        text-align: center;
      }
      .cc-metric-label {
        font-family: monospace;
        font-size: 0.58rem;
        color: rgba(138,149,165,0.6);
        letter-spacing: 0.08em;
        margin-bottom: 4px;
      }
      .cc-metric-val {
        font-family: "Oxanium", sans-serif;
        font-size: 0.82rem;
        font-weight: 800;
        color: #f0f4f9;
        letter-spacing: -0.01em;
        line-height: 1;
      }
      .cc-metric-val.green  { color: #3fb950; }
      .cc-metric-val.yellow { color: #ffcc00; }
      .cc-metric-val.orange { color: #ff8833; }
      .cc-metric-val.red    { color: #ff3333; }
      .cc-metric-val.cyan   { color: #00d4ff; }
      /* SHS-4: NUCLEAR metric val */
      .cc-metric-val.nuclear,
      .cc-metric-val.black {
        color: #ff0000;
        text-shadow: 0 0 8px rgba(255,0,0,0.6);
        animation: ccNuclearPulse 0.6s ease-in-out infinite alternate;
      }

      .cc-bar-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .cc-bar-label {
        font-family: monospace;
        font-size: 0.58rem;
        color: rgba(138,149,165,0.5);
        letter-spacing: 0.08em;
        min-width: 54px;
        flex-shrink: 0;
      }
      .cc-bar-track {
        flex: 1;
        height: 5px;
        background: rgba(6,8,11,0.7);
        border-radius: 999px;
        overflow: hidden;
      }
      .cc-bar-fill {
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(90deg, #3fb950, #00d4ff);
        width: 100%;
        transition: width 0.9s cubic-bezier(0.2,0,0,1);
      }
      .cc-bar-fill.degraded { background: linear-gradient(90deg, #ff8833, #ff3333); }
      .cc-bar-fill.danger   { background: linear-gradient(90deg, #dd1111, #ff6600); }
      .cc-bar-pct {
        font-family: monospace;
        font-size: 0.62rem;
        color: rgba(138,149,165,0.6);
        min-width: 32px;
        text-align: right;
      }

      .cc-warden-row {
        display: flex;
        align-items: center;
        gap: 10px;
        background: rgba(6,8,11,0.4);
        border: 1px solid rgba(221,17,17,0.1);
        border-radius: 10px;
        padding: 10px 12px;
        margin: 10px 0;
        transition: border-color 0.3s ease, background 0.3s ease;
      }
      .cc-warden-row.alert {
        border-color: rgba(221,17,17,0.35);
        background: rgba(221,17,17,0.06);
      }
      .cc-warden-icon {
        font-size: 1.4rem;
        color: #ff3333;
        flex-shrink: 0;
        text-shadow: 0 0 8px rgba(221,17,17,0.4);
        line-height: 1;
      }
      .cc-warden-info { flex: 1; min-width: 0; }
      .cc-warden-title {
        font-size: 0.72rem;
        font-weight: 700;
        color: #f0f4f9;
        letter-spacing: 0.02em;
        margin-bottom: 2px;
      }
      .cc-warden-desc {
        font-family: monospace;
        font-size: 0.6rem;
        color: rgba(138,149,165,0.6);
        line-height: 1.4;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .cc-badge {
        font-family: "Oxanium", sans-serif;
        font-size: 0.58rem;
        font-weight: 700;
        letter-spacing: 0.1em;
        padding: 3px 8px;
        border-radius: 999px;
        border: 1px solid;
        flex-shrink: 0;
      }
      .cc-badge.dormant  { color: #3fb950; border-color: rgba(63,185,80,0.3);   background: rgba(63,185,80,0.08); }
      .cc-badge.primed   { color: #ff8833; border-color: rgba(255,136,51,0.3);  background: rgba(255,136,51,0.08); }
      .cc-badge.manifest { color: #ff3333; border-color: rgba(221,17,17,0.4);   background: rgba(221,17,17,0.1); }

      .cc-session-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
      }
      .cc-session-val {
        font-family: monospace;
        font-size: 0.68rem;
        font-weight: 700;
        color: #ff8833;
        letter-spacing: 0.04em;
      }

      .cc-log {
        font-family: monospace;
        font-size: 0.65rem;
        line-height: 1.6;
        color: rgba(138,149,165,0.7);
        background: rgba(6,8,11,0.5);
        border-radius: 8px;
        padding: 8px 10px;
        height: 80px;
        overflow-y: auto;
        margin-bottom: 10px;
        display: flex;
        flex-direction: column-reverse;
      }
      .cc-log::-webkit-scrollbar { width: 3px; }
      .cc-log::-webkit-scrollbar-thumb { background: rgba(221,17,17,0.2); border-radius: 999px; }
      .cc-log-line { color: #dce2eb; }
      .cc-log-line .t  { color: rgba(138,149,165,0.4); }
      .cc-log-line .ok { color: #3fb950; font-weight: 700; }
      .cc-log-line .wn { color: #ff8833; font-weight: 700; }
      .cc-log-line .er { color: #ff3333; font-weight: 700; }
      .cc-log-line .in { color: #00d4ff; font-weight: 700; }
      /* SHS-4: nuclear log class */
      .cc-log-line .nx { color: #ff0000; font-weight: 700; text-shadow: 0 0 4px rgba(255,0,0,0.5); }

      .cc-controls {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .cc-btn {
        font-family: "Oxanium", sans-serif;
        font-size: 0.62rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        padding: 6px 10px;
        border-radius: 7px;
        border: 1px solid rgba(221,17,17,0.2);
        background: rgba(22,26,34,0.8);
        color: rgba(138,149,165,0.8);
        cursor: pointer;
        transition: all 200ms ease;
        text-decoration: none;
        display: inline-block;
      }
      .cc-btn:hover {
        border-color: rgba(255,102,0,0.45);
        color: #ff8833;
        background: rgba(255,102,0,0.06);
      }
      .cc-btn-link { color: rgba(138,149,165,0.7); }

      @media (max-width: 640px) {
        #cc-overlay {
          bottom: 24px;
          left: 12px;
          right: auto;
          flex-direction: column-reverse;
          align-items: flex-start;
          z-index: 40;
          max-width: calc(100vw - 24px);
        }
        #cc-tab {
          padding: 6px 12px;
          font-size: 0.68rem;
          align-self: flex-start;
        }
        #cc-panel {
          width: 0;
          align-self: flex-start;
        }
        #cc-panel.open {
          width: min(360px, calc(100vw - 32px));
          max-height: 600px;
          align-self: flex-start;
        }
        .cc-panel-inner {
          width: 100%;
          max-width: 360px;
        }
        .mobile-nav, .mobile-menu, .hamburger-panel, .nav-drawer {
          z-index: 200;
        }
      }

      #cc-overlay.cc-hidden {
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
        transform: translateY(12px);
      }

      body.mobile-menu-open #cc-overlay,
      body.menu-open         #cc-overlay,
      body.nav-open          #cc-overlay,
      body.hamburger-open    #cc-overlay {
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      /* HIGH-3 PATCH: .entropia-sigil root block removed.
         .high-drift kept but scoped to non-floating sigils. */
      .entropia-sigil:not(.entropia-sigil--hero-bg).high-drift {
        filter: contrast(1.15) brightness(1.08) hue-rotate(8deg);
        animation: orp-sigil-glitch 0.4s linear infinite alternate;
      }
      @keyframes orp-sigil-glitch {
        0%   { transform: translate(0,    0); }
        20%  { transform: translate(-2px, 2px); }
        40%  { transform: translate( 2px,-2px); }
        60%  { transform: translate(-1px, 1px); }
        100% { transform: translate( 1px,-1px); }
      }

      @media (prefers-reduced-motion: reduce) {
        .cc-dot, #cc-tab  { animation: none !important; transition: none !important; }
        #cc-panel          { transition: none !important; }
        .cc-bar-fill       { transition: none !important; }
        .cc-shs-pill.nuclear,
        .cc-shs-pill.black,
        .cc-metric-val.nuclear,
        .cc-metric-val.black { animation: none !important; }
      }
    `;
    document.head.appendChild(style);
  }

  /* ── Log ────────────────────────────────────────────────── */
  /* MEDIUM-4 PATCH: single-entry prepend, O(1) */
  function addLog(tagClass, tag, msg) {
    const timestamp = nowStr();

    state.logEntries.unshift({ time: timestamp, tagClass, tag, msg });
    if (state.logEntries.length > 60) state.logEntries.pop();

    const el = _dom().log;
    if (!el) return;

    const line = document.createElement("div");
    line.className = "cc-log-line";
    line.innerHTML = `<span class="t">${timestamp}</span> <span class="${tagClass}">${tag}</span> ${msg}`;
    el.prepend(line);

    while (el.children.length > 60) el.removeChild(el.lastChild);
  }

  /* ── Warden config ──────────────────────────────────────── */
  const WARDEN = {
    DORMANT:  { cls:"dormant",  icon:"⬡", title:"Warden — DORMANT",   desc:"No drift detected. Epistemic isolation nominal." },
    PRIMED:   { cls:"primed",   icon:"◈", title:"Warden — PRIMED",    desc:"Entropy accumulating. J⊥ detection elevated." },
    MANIFEST: { cls:"manifest", icon:"⛒", title:"Warden — MANIFEST",  desc:"Threshold exceeded. CRA validation in progress." },
  };

  function applyWarden(s) {
    const cfg = WARDEN[s];
    const d   = _dom();
    if (!d.wardenIcon) return;
    d.wardenIcon.textContent  = cfg.icon;
    d.wardenTitle.textContent = cfg.title;
    d.wardenDesc.textContent  = cfg.desc;
    d.wardenBadge.textContent = s;
    d.wardenBadge.className   = `cc-badge ${cfg.cls}`;
    d.wardenRow.className     = `cc-warden-row${s === "MANIFEST" ? " alert" : ""}`;
  }

  /* ──────────────────────────────────────────────────────────
     SHS-1: Monotonic Hysteresis State Machine
     ──────────────────────────────────────────────────────────

     DEGRADATION THRESHOLDS (ρ):
       GREEN  → ρ ≥ 75
       YELLOW → ρ ∈ [55, 75)
       ORANGE → ρ ∈ [35, 55)
       RED    → ρ ∈ [15, 35)
       BLACK  → ρ < 15  (or forced by high warden + drift)

     Degradation is IMMEDIATE on threshold crossing.
     Recovery is STEPWISE (one level per STABILITY_TICKS ticks).
     BLACK is ABSORBING — only Architect reset can exit.

     Combined drift = synthetic(ΔS, ρ) + perf telemetry + jitter.
     This is the single source of truth passed to updateSigilDrift.
  ─────────────────────────────────────────────────────────── */

  /* Map SHS level name → CSS class used in DOM */
  const SHS_CSS_CLASS = {
    GREEN:  "green",
    YELLOW: "yellow",
    ORANGE: "orange",
    RED:    "red",
    BLACK:  "nuclear",
  };

  /* Minimum rho required to be eligible for each state */
  const SHS_DEGRADE_THRESHOLDS = {
    GREEN:  75,
    YELLOW: 55,
    ORANGE: 35,
    RED:    15,
    BLACK:   0,
  };

  /* Minimum rho required to RECOVER to each state (hysteresis gap) */
  const SHS_RECOVER_THRESHOLDS = {
    GREEN:  80,   // must be clearly above 75 before stepping back to GREEN
    YELLOW: 62,
    ORANGE: 42,
    RED:    20,
  };

  /* What updateSigilFromSHS expects — maps our 5-state to its 5-state */
  const SHS_TO_SIGIL = {
    GREEN:  "GREEN",
    YELLOW: "YELLOW",
    ORANGE: "ORANGE",
    RED:    "RED",
    BLACK:  "BLACK",
  };

  /* The OLD 3-state→3-state pill labels the rest of the codebase used */
  const SHS_COLOR = {
    GREEN:  "green",
    YELLOW: "yellow",
    ORANGE: "orange",
    RED:    "red",
    BLACK:  "nuclear",
  };

  /*
    stepSHSMachine(rho, combinedDrift, ts)
    ----------------------------------------
    Called once per decay tick from inside _rafLoop.
    Reads + writes window._orpSHSState.
    Returns new SHS state string.
  */
  function stepSHSMachine(rho, combinedDrift, ts) {
    const machine = window._orpSHSState;
    const current = machine.currentState;

    /* BLACK is absorbing — never step automatically */
    if (current === "BLACK") return "BLACK";

    const currentIdx = SHS_STATES.indexOf(current);

    /* ── DEGRADATION (immediate) ──────────────────────────
       Find the worst state that rho qualifies for.
       Also force BLACK if warden is MANIFEST AND drift is high. */
    let targetIdx = 0; // default GREEN
    for (let i = SHS_STATES.length - 1; i >= 0; i--) {
      if (rho < SHS_DEGRADE_THRESHOLDS[SHS_STATES[i]]) {
        // ρ is BELOW this state's floor → we're at this state or worse
        targetIdx = Math.min(i + 1, SHS_STATES.length - 1);
        break;
      }
    }
    // Correct mapping: states degrade when rho falls BELOW threshold
    // Remap: GREEN requires rho ≥ 75; YELLOW requires rho ≥ 55; etc.
    targetIdx = 0;
    if (rho < 15)      targetIdx = 4; // BLACK
    else if (rho < 35) targetIdx = 3; // RED
    else if (rho < 55) targetIdx = 2; // ORANGE
    else if (rho < 75) targetIdx = 1; // YELLOW
    else               targetIdx = 0; // GREEN

    // Warden MANIFEST + very high drift forces BLACK regardless of rho
    if (state.wardenState === "MANIFEST" && combinedDrift > 0.85) {
      targetIdx = 4; // BLACK
    }

    /* ── IMMEDIATE DEGRADATION ───────────────────────────── */
    if (targetIdx > currentIdx) {
      const newState = SHS_STATES[targetIdx];
      _logSHSTransition(current, newState, ts, "DRIFT");
      machine.currentState     = newState;
      machine.lastTransitionTs = ts;
      machine.stabilityCounter = 0;
      return newState;
    }

    /* ── STEPWISE RECOVERY ───────────────────────────────── */
    if (targetIdx < currentIdx) {
      // Check hysteresis: rho must also clear the recovery threshold
      const stepUpState   = SHS_STATES[currentIdx - 1];
      const recoverFloor  = SHS_RECOVER_THRESHOLDS[stepUpState] ?? 0;
      const driftIsLow    = combinedDrift < 0.18;
      const rhoIsClear    = rho >= recoverFloor;

      if (driftIsLow && rhoIsClear) {
        machine.stabilityCounter++;
      } else {
        machine.stabilityCounter = 0;
      }

      if (machine.stabilityCounter >= STABILITY_TICKS) {
        machine.stabilityCounter = 0;
        machine.lastTransitionTs = ts;
        machine.currentState     = stepUpState;
        _logSHSTransition(current, stepUpState, ts, "STABLE");
        return stepUpState;
      }
    } else {
      // rho agrees with current state — accumulate stability
      if (combinedDrift < 0.18) {
        machine.stabilityCounter = Math.min(
          machine.stabilityCounter + 1,
          STABILITY_TICKS
        );
      } else {
        machine.stabilityCounter = 0;
      }
    }

    return current;
  }

  function _logSHSTransition(from, to, _ts, reason) {
    const isDegrade  = SHS_STATES.indexOf(to) > SHS_STATES.indexOf(from);
    const tagClass   = to === "BLACK" ? "nx" : isDegrade ? "er" : "ok";
    const reasonTag  = reason === "STABLE" ? "↑STAB" : "↓DRFT";
    addLog(tagClass, "SHS", `${from}→${to} [${reasonTag}]`);
    if (to === "BLACK") {
      addLog("nx", "⛒BLK", "TERMINAL STATE — Architect reset required");
    }
  }

  /* ── Update DOM ─────────────────────────────────────────── */
  function update() {
    const d = _dom();

    // ΔS
    if (d.ds) d.ds.textContent = fmt4(state.deltaS);

    // ρ(x)
    if (d.rho) { d.rho.textContent = fmt1(state.rho); d.rho.className = "cc-metric-val cyan"; }
    if (d.rhoBar) {
      d.rhoBar.style.width = clamp(state.rho, 2, 100) + "%";
      d.rhoBar.className   = `cc-bar-fill${state.rho < 60 ? " degraded" : ""}`;
    }
    if (d.rhoPct) d.rhoPct.textContent = Math.round(state.rho) + "%";

    /* SHS-1: Machine state drives all SHS display.
       We read machine.currentState (set by stepSHSMachine in _rafLoop)
       and use it for all pill/metric updates. update() itself no longer
       calls calcSHS — the machine is the sole authority. */
    const newSHS = window._orpSHSState.currentState;
    if (newSHS !== state.shs) {
      state.shs = newSHS;
    }
    const shsClass = SHS_CSS_CLASS[state.shs] || "green";
    if (d.shs) { d.shs.textContent = state.shs; d.shs.className = `cc-metric-val ${shsClass}`; }
    if (d.pill) { d.pill.textContent = state.shs; d.pill.className = `cc-shs-pill ${shsClass}`; }

    // Warden %
    if (d.wpct) {
      const wpct = Math.round(state.warden);
      d.wpct.textContent = wpct + "%";
      d.wpct.className   = `cc-metric-val${state.warden >= 72 ? " red" : state.warden >= 45 ? " orange" : ""}`;
    }
    if (d.wBar)  d.wBar.style.width  = clamp(state.warden, 0, 100) + "%";
    if (d.wPct)  d.wPct.textContent  = Math.round(state.warden) + "%";

    // Warden state machine (3-state, unchanged)
    const newW = state.warden >= 72 ? "MANIFEST" : state.warden >= 45 ? "PRIMED" : "DORMANT";
    if (newW !== state.wardenState) {
      addLog(newW === "MANIFEST" ? "er" : newW === "PRIMED" ? "wn" : "ok",
        newW, `W: ${state.wardenState}→${newW}`);
      if (newW === "MANIFEST") addLog("er", "J⊥", "VORTEX — chain locked");
      state.wardenState = newW;
    }
    applyWarden(state.wardenState);

    // Session entropy
    state.sessionEntropy += state.deltaS * 0.01;
    _debouncedSave();
    if (d.sessionVal) d.sessionVal.textContent = fmt4(state.sessionEntropy);

    // Page label
    if (d.pageLabel) {
      const pg = window.location.pathname.split("/").pop() || "index.html";
      d.pageLabel.textContent = pg.replace(".html","").toUpperCase() || "INDEX";
    }

    if (_dom().asciiPanel) _syncAsciiPanel(state.shs);
  }

  /* ── Inject delta ───────────────────────────────────────── */
  /* BUG-2 PATCH: gate on BLACK state. scroll/click listeners called
     injectDelta() unconditionally, mutating state.rho + state.warden
     even while BLACK (decay() froze them, but injectDelta ran first,
     corrupting values before the clamp). Return immediately in BLACK,
     but the caller still stamps the event timestamp for SHS-3 jitter
     telemetry — that signal stays live even in BLACK. */
  function injectDelta(ds) {
    if (window._orpSHSState.currentState === "BLACK") return;
    state.deltaS = clamp(ds, 0, 0.25);
    state.rho    = clamp(state.rho    - ds * 160, 0, 100);
    state.warden = clamp(state.warden + ds * 300, 0, 100);
    addLog("in", "INF", `ΔS:${fmt4(ds)} ρ:${fmt1(state.rho)}`);
    update();
  }

  /* ── Passive decay ──────────────────────────────────────── */
  function decay() {
    /* BLACK state: no automatic recovery of ρ or warden.
       Decay continues to update deltaS so drift doesn't freeze,
       but rho and warden are locked until Architect reset. */
    if (window._orpSHSState.currentState === "BLACK") {
      state.deltaS = clamp(state.deltaS - 0.0001, 0, 1);
      update();
      return;
    }
    state.rho    = clamp(state.rho    + 0.10,   0, 100);
    state.warden = clamp(state.warden - 0.40,   0, 100);
    state.deltaS = clamp(state.deltaS - 0.0001, 0, 1);
    update();
  }

  /* ── Session entropy → Warden pre-load ─────────────────── */
  function applySessionPressure() {
    const pressure = clamp(state.sessionEntropy / 500, 0, 1);
    if (pressure > 0.05) {
      state.warden = clamp(pressure * 65, 0, 65);
      state.rho    = clamp(100 - pressure * 40, 60, 100);
      addLog("wn", "SES", `Session pressure: ${(pressure * 100).toFixed(0)}%`);
      update();
    }
  }

  /* ── ASCII panel live sync ──────────────────────────────── */
  const ASCII_SHS_STYLE = {
    GREEN:  { color: '#3fb950', glow: 'rgba(63,185,80,0.45)',  char: '~', label: '[= STAR =]',  core: '[ CORE ]' },
    YELLOW: { color: '#ffcc00', glow: 'rgba(255,204,0,0.45)',  char: '≈', label: '[~ STAR ~]',  core: '[ CORE ]' },
    AMBER:  { color: '#ff8833', glow: 'rgba(255,136,51,0.5)',  char: '≈', label: '[≈ STAR ≈]',  core: '[ CORE ]' },
    ORANGE: { color: '#ff8833', glow: 'rgba(255,136,51,0.5)',  char: '≈', label: '[≈ STAR ≈]',  core: '[ CORE ]' },
    RED:    { color: '#ff3333', glow: 'rgba(221,17,17,0.6)',   char: '!', label: '[! STAR !]',  core: '[!CORE!]' },
    BLACK:  { color: '#ff0000', glow: 'rgba(255,0,0,0.8)',     char: '█', label: '[█ DEAD █]',  core: '[!NULL!]' },
  };
  const GLITCH_POOL = ['█','▓','▒','░','╳','╬','╫','╪','║','═','╔','╗'];
  let _asciiFrame  = 0;
  let _lastAsciiSHS = '';

  function _syncAsciiPanel(shs) {
    const panel = _dom().asciiPanel;
    if (!panel) return;

    const key  = ASCII_SHS_STYLE[shs] ? shs : 'GREEN';
    const cfg  = ASCII_SHS_STYLE[key];
    _asciiFrame++;

    // MEDIUM-2 PATCH: use memoized _getSigils()
    const drift = parseFloat(
      _getSigils()[0]?.style.getPropertyValue('--drift-intensity') || '0'
    );

    if (shs !== _lastAsciiSHS) {
      _lastAsciiSHS = shs;
      panel.style.color      = cfg.color;
      panel.style.textShadow = `0 0 6px ${cfg.glow}, 0 0 14px ${cfg.glow.replace(/[\d.]+\)$/, '0.2)')}`;
    }

    const wave  = _buildWave(cfg.char, drift, _asciiFrame);
    const wL    = ((key === 'RED' || key === 'BLACK') && Math.random() > 0.6) ? _glitchStr('//', drift) : '//';
    const wR    = ((key === 'RED' || key === 'BLACK') && Math.random() > 0.6) ? _glitchStr('//', drift) : '//';
    const coreLabel = (drift > 0.55 && Math.random() > 0.5)
      ? _glitchStr(cfg.core, drift) : cfg.core;

    panel.textContent =
`    ${wL}              ${wR}
   ${wL}              ${wR}
  ${wL}              ${wR}
 ${wL}              ${wR}
 ||      __________      ||
 ||     /          \\     ||
 ||    |  ${wave}  |    ||
 ||    | ( ( || ) ) |    ||
 ||    |     ||     |    ||
  \\\\    \\__________/    //
   \\\\________||________//
        ${cfg.label}
       / ${coreLabel} \\
      /____________\\`;
  }

  function _buildWave(char, drift, frame) {
    const len   = 8;
    const shift = frame % len;
    let   out   = '';
    for (let i = 0; i < len; i++) {
      out += ((i + shift) % len < 2 && drift > 0.25) ? char : '~';
    }
    return out;
  }

  function _glitchStr(str, drift) {
    if (drift < 0.4) return str;
    return str.split('').map(c =>
      (Math.random() < drift * 0.4)
        ? GLITCH_POOL[Math.floor(Math.random() * GLITCH_POOL.length)]
        : c
    ).join('');
  }

  /* ── Init ───────────────────────────────────────────────── */
  function init() {
    buildStyles();
    buildOverlay();

    /* BUG-1 PATCH: menuObserver was watching document.body for
       'mobile-menu-open', but main.js sets 'menu-open' on nav#main-nav —
       never on body. Now observes BOTH nodes. Trigger logic checks the nav
       element's 'menu-open' class as the primary signal (what main.js
       actually sets), falling back to body for future consumers.
       CSS cc-hidden selectors kept broad (defensive). */
    const overlay    = document.getElementById("cc-overlay");
    const navElement = document.getElementById("main-nav");

    const _checkMenuState = () => {
      const menuOpen =
        navElement?.classList.contains("menu-open") ||
        document.body.classList.contains("mobile-menu-open") ||
        document.body.classList.contains("menu-open");
      overlay?.classList.toggle("cc-hidden", menuOpen);
      if (menuOpen && state.panelOpen) {
        state.panelOpen = false;
        const d = _dom();
        d.panel?.classList.remove("open");
        d.tab?.setAttribute("aria-expanded", "false");
        d.panel?.setAttribute("aria-hidden", "true");
      }
    };

    const menuObserver = new MutationObserver(_checkMenuState);
    // Watch body for legacy/future body-class consumers
    menuObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    // Watch nav for main.js's actual 'menu-open' toggle (BUG-1 primary fix)
    if (navElement) {
      menuObserver.observe(navElement, { attributes: true, attributeFilter: ["class"] });
    }

    // Tab toggle
    const d = _dom();
    d.tab?.addEventListener("click", () => {
      state.panelOpen = !state.panelOpen;
      d.panel?.classList.toggle("open", state.panelOpen);
      d.tab.setAttribute("aria-expanded", state.panelOpen ? "true" : "false");
      d.panel?.setAttribute("aria-hidden", state.panelOpen ? "false" : "true");
    });

    // Inject button
    document.getElementById("cc-inject")?.addEventListener("click", () => {
      injectDelta(0.025 + Math.random() * 0.055);
    });

    // Reset button — Architect reset: exits BLACK state
    document.getElementById("cc-reset")?.addEventListener("click", () => {
      const machine = window._orpSHSState;
      if (machine.currentState === "BLACK" || state.wardenState === "MANIFEST") {
        addLog("ok", "CRA", "Architect reset initiated…");
        setTimeout(() => {
          // Full BLACK exit: restore rho, clear warden, reset machine state
          machine.currentState     = "GREEN";
          machine.stabilityCounter = 0;
          machine.lastTransitionTs = performance.now();
          state.rho    = 85;
          state.warden = 0;
          state.deltaS = 0;
          saveSessionEntropy(state.sessionEntropy * 0.5);
          state.sessionEntropy = loadSessionEntropy();
          addLog("ok", "CRA", "Chain restored — Warden deactivated");
          update();
        }, 1000);
      } else {
        machine.currentState     = "GREEN";
        machine.stabilityCounter = 0;
        state.rho    = 100;
        state.warden = 0;
        state.deltaS = 0;
        addLog("ok", "OK", "Baseline reset — metrics nominal");
        update();
      }
    });

    /* ── SHS-3: Event latency telemetry ──────────────────────
       Stamp performance.now() on every scroll/click event.
       _rafLoop reads the gap once per sigil-sync tick.
       Zero DOM writes in these listeners.

       BUG-3 PATCH: injectDelta() is severed in BLACK state (see
       injectDelta gate). The timestamp is still written here so jitter
       telemetry (SHS-3) remains live — the OUTPUT/display pipeline stays
       hot even though the entropy INPUT pipeline is severed. */
    let lastScrollY = window.scrollY, accum = 0;
    window.addEventListener("scroll", () => {
      window._orpSHSState.lastScrollTs = performance.now(); // always stamp (BUG-3)
      const delta = Math.abs(window.scrollY - lastScrollY);
      accum += delta; lastScrollY = window.scrollY;
      if (accum > 150) {
        injectDelta(clamp((accum / 12000) * 0.5, 0.001, 0.035)); // no-op in BLACK
        accum = 0;
      }
    }, { passive: true });

    document.addEventListener("click", (e) => {
      window._orpSHSState.lastClickTs = performance.now(); // always stamp (BUG-3)
      if (e.target.closest("#cc-overlay")) return;
      injectDelta(0.002 + Math.random() * 0.004); // no-op in BLACK
    });

    /* ──────────────────────────────────────────────────────────
       rAF-capped loop: decay + SHS machine + sigil sync
       SHS-2: Real perf telemetry measured here.

       Delta-time is measured every frame.
       Slow frames (> 33ms = < 30fps) inject drift pressure.
       This reflects genuine GPU/CPU load, not just simulated ΔS.

       Decay:        ~900ms
       Sigil sync:   ~800ms (also runs SHS machine)
    ─────────────────────────────────────────────────────────── */
    let _lastDecayTs   = 0;
    let _lastSigilTs   = 0;
    let _lastSigilSHS  = '';
    let _lastRafTs     = 0;          // SHS-2: previous rAF timestamp
    const _FPS_ALPHA   = 0.1;        // EMA smoothing factor for fps

    function _rafLoop(ts) {
      /* SHS-2: Measure real delta-time and update perf telemetry */
      const rawDelta = _lastRafTs > 0 ? ts - _lastRafTs : 16.67;
      _lastRafTs = ts;

      const machine = window._orpSHSState;
      machine.lastFrameDelta = rawDelta;
      // Exponential moving average for fps — stable, no allocation
      machine.frameRate = machine.frameRate * (1 - _FPS_ALPHA)
                        + (1000 / rawDelta) * _FPS_ALPHA;

      /* SHS-2: Convert frame slowness to drift pressure.
         Target: 60fps → 16.67ms. Frames > 33ms are "slow" (< 30fps).
         Slow frames add up to PERF_DRIFT_SCALE drift pressure.
         Normalized so one very-slow frame adds at most ~0.08 drift units. */
      if (rawDelta > 33) {
        const slowness = clamp((rawDelta - 33) / 200, 0, 1); // 0→1 as delta→233ms
        machine.perfDriftPressure = clamp(
          machine.perfDriftPressure * 0.95 + slowness * PERF_DRIFT_SCALE,
          0, 1
        );
      } else {
        // Fast frame: decay perf pressure
        machine.perfDriftPressure = machine.perfDriftPressure * 0.90;
      }

      /* MEDIUM-1 PATCH: early-exit when neither decay nor sigil-sync is due */
      const needsDecay = ts - _lastDecayTs >= 900;
      const needsSigil = ts - _lastSigilTs  >= 800;
      if (!needsDecay && !needsSigil) {
        state._rafHandle = requestAnimationFrame(_rafLoop);
        return;
      }

      if (needsDecay) {
        decay();
        _lastDecayTs = ts;
      }

      if (needsSigil) {
        /* SHS-3: Event jitter telemetry.
           Read the gap between the rAF timestamp and the last scroll/click event.
           High jitter (> 80ms) means the event queue is backed up — adds drift. */
        const lastEventTs = Math.max(machine.lastScrollTs, machine.lastClickTs);
        if (lastEventTs > 0) {
          machine.eventJitter = clamp(ts - lastEventTs, 0, 500);
          machine.jitterDrift = machine.eventJitter > 80
            ? clamp((machine.eventJitter - 80) / 400, 0, 0.15)
            : 0;
        }

        /* SHS-1 + SHS-2 + SHS-3: Compute combined drift.
           Synthetic: existing ΔS and ρ signals.
           Real perf: slow frame pressure.
           Jitter:    event latency pressure. */
        const syntheticDrift = clamp(state.deltaS * 4 + (100 - state.rho) / 100, 0, 1);
        const combinedDrift  = clamp(
          syntheticDrift + machine.perfDriftPressure + machine.jitterDrift,
          0, 1
        );

        /* SHS-1: Tick the state machine.
           stepSHSMachine handles all hysteresis logic and logs transitions. */
        const newMachineState = stepSHSMachine(state.rho, combinedDrift, ts);

        // Sync state.shs with machine (update() reads state.shs)
        if (newMachineState !== state.shs) {
          state.shs = newMachineState;
        }

        // Drive sigil visual from combined drift (not just synthetic)
        _getSigils().forEach(s => {
          s.classList.toggle('high-drift', combinedDrift > 0.55);
        });

        // Drive sigil glow/animation from SHS state
        const pill = _dom().pill;
        if (pill) {
          const sigilState = SHS_TO_SIGIL[newMachineState] || 'GREEN';
          if (sigilState !== _lastSigilSHS) {
            _lastSigilSHS = sigilState;
            if (typeof window.updateSigilFromSHS === 'function') {
              window.updateSigilFromSHS(sigilState);
            }
            if (_dom().asciiPanel) _syncAsciiPanel(newMachineState);
          }
        }

        // Always push combined drift to sigil so it reflects real perf load
        if (typeof window.updateSigilDrift === 'function') {
          window.updateSigilDrift(combinedDrift);
        }

        _lastSigilTs = ts;
      }

      state._rafHandle = requestAnimationFrame(_rafLoop);
    }
    state._rafHandle = requestAnimationFrame(_rafLoop);
    window._orpRafActive = true;

    /* LOW-1 + LOW-3 PATCH: cleanup on page unload */
    window.addEventListener('pagehide', () => {
      if (state._rafHandle) { cancelAnimationFrame(state._rafHandle); state._rafHandle = null; }
      if (_saveTimer) { clearTimeout(_saveTimer); saveSessionEntropy(state.sessionEntropy); }
      menuObserver.disconnect();
    }, { once: true });

    applySessionPressure();
    if (_dom().asciiPanel) _syncAsciiPanel('GREEN');

    const page = (window.location.pathname.split("/").pop() || "index.html")
      .replace(".html","").toUpperCase();
    addLog("ok", "CC",  `Initialized on ${page}`);
    addLog("in", "J⊥", "VORTEX detection: ENGAGED");
    addLog("ok", "ISO", "Epistemic isolation: NOMINAL");
    update();
  }

  /* ── Boot ───────────────────────────────────────────────── */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
