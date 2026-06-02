/* ============================================================
   ORP v3.0 — Clinical Core: Global Runtime Overlay
   runtime-overlay.js

   Drop <script src="assets/js/runtime-overlay.js"></script>
   in every page AFTER main.js. This file:
     1. Injects the NESS HUD into the DOM on every page
     2. Binds scroll + click entropy to the NESS engine
     3. Persists cumulative session entropy via sessionStorage
     4. Manages Warden state across the whole site

   PATCH LOG (v3.0.1–v3.0.3): [original patches preserved — see git]
   PATCH LOG (v3.1.0 — Firefox GPU + Overlay / Graphics fixes): [preserved]

   PATCH LOG (v3.2.0 — Full Inter-Sync):
     SYNC-5  — Boot hydration from ORP_SYNC:
               On init, ness_pressure is loaded from ORP_SYNC and applied
               to window._orpSHSState.currentState so the SHS machine
               resumes at the correct state on page load / cross-tab
               navigation rather than always starting at GREEN.
     SYNC-6  — Boot hydration for Warden state:
               ness_warden_active is loaded on init and pre-loads
               state.warden / state.wardenState so the Warden bar
               reflects the persisted MANIFEST/PRIMED/DORMANT status
               immediately on any page without waiting for a tick.
     SYNC-7  — Cross-tab ness_warden_active listener:
               orp-settings-update now handles 'ness_warden_active'.
               When another tab's Warden fires or clears, this overlay
               updates its warden bar/badge instantly.
     SYNC-8  — sigil_drift written back to ORP_SYNC:
               updateSigilDrift-equivalent drift value (combinedDrift)
               is persisted via ORP_SYNC.save('sigil_drift', …) inside
               the rAF loop whenever the sigil is updated, ensuring
               entropia-sigil.js on other pages stays in sync.
     SYNC-9  — Coordinator telemetry bridge:
               Listens to 'orp-telemetry-request' events emitted by
               ORP_COORDINATOR. Logs run ID, consensus, drift, and mode
               to the cc-log panel for real-time coordinator visibility.
     SYNC-10 — orp-runtime-mode-change bridge:
               Listens to coordinator mode-change events and logs them
               to the cc-log with appropriate severity tags.
   ============================================================ */

(() => {
  "use strict";

  /* ── Guard: only one instance per page ─────────────────── */
  if (document.getElementById("cc-overlay")) return;

  /* ── Session entropy persistence ───────────────────────── */
  /* NESS-SYNC: Prefer ORP_SYNC (localStorage + cross-tab broadcast)
     over bare sessionStorage.  Falls back silently when orp-sync.js
     is absent so this file remains independently deployable. */
  const SS_KEY            = "orp_session_entropy";   /* legacy key kept for backward compat */
  const loadSessionEntropy = () => {
    if (window.ORP_SYNC) {
      return parseFloat(ORP_SYNC.load('ness_entropy', 0)) || 0;
    }
    return parseFloat(sessionStorage.getItem(SS_KEY) || "0");
  };
  const saveSessionEntropy = (v) => {
    if (window.ORP_SYNC) {
      ORP_SYNC.save('ness_entropy', v);
      return;
    }
    sessionStorage.setItem(SS_KEY, String(v));
  };

  /* MEDIUM-5 PATCH: debounced sessionStorage write */
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
     SHS-1: Persistent machine state
  ─────────────────────────────────────────────────────────── */
  const SHS_STATES      = ["GREEN", "YELLOW", "ORANGE", "RED", "BLACK"];
  const STABILITY_TICKS = 8;
  const PERF_DRIFT_SCALE = 0.08;

  window._orpSHSState = {
    currentState:      "GREEN",
    lastTransitionTs:  0,
    stabilityCounter:  0,
    lastFrameDelta:    0,
    frameRate:         60,
    perfDriftPressure: 0,
    lastScrollTs:      0,
    lastClickTs:       0,
    eventJitter:       0,
    jitterDrift:       0,
  };

  /* ─────────────────────────────────────────────────────────
     SYNC-5 / SYNC-6: Boot hydration from ORP_SYNC
     Restore SHS machine state and Warden bar from persisted
     values so every page load begins at the correct runtime
     state rather than a cold GREEN/DORMANT baseline.
  ─────────────────────────────────────────────────────────── */
  (function _hydrateFromORP_SYNC() {
    if (!window.ORP_SYNC) return;

    /* SYNC-5: restore SHS machine state */
    const persistedSHS = ORP_SYNC.load('ness_pressure', 'GREEN');
    if (SHS_STATES.includes(persistedSHS)) {
      window._orpSHSState.currentState = persistedSHS;
      state.shs = persistedSHS;
    }

    /* SYNC-6: restore Warden state from ness_warden_active flag.
       Pre-load the warden bar so badge/icon are correct on first render. */
    const wardenActive = ORP_SYNC.load('ness_warden_active', false);
    if (wardenActive === true) {
      /* Put warden into MANIFEST territory so the first update() renders
         the badge immediately without waiting for a decay tick. */
      state.warden      = 75;
      state.wardenState = 'MANIFEST';
    }

    /* Also restore rho from persisted SHS-to-rho approximation */
    const shsToRho = { GREEN: 100, YELLOW: 80, ORANGE: 58, RED: 30, BLACK: 5 };
    if (shsToRho[persistedSHS] !== undefined && persistedSHS !== 'GREEN') {
      state.rho = shsToRho[persistedSHS];
    }
  }());

  /* ── Helpers ────────────────────────────────────────────── */
  const clamp  = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmt4   = n => n.toFixed(4);
  const fmt1   = n => n.toFixed(1);
  const nowStr = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

  /* ── Cached DOM refs ────────────────────────────────────── */
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
      /* FF-1 FIX: No will-change/translateZ on the root */
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
        contain: layout style paint;
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
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
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
      .cc-shs-pill.nuclear,
      .cc-shs-pill.black {
        color: #ff0000;
        border-color: rgba(255,0,0,0.6);
        background: rgba(255,0,0,0.18);
        animation: ccNuclearPulse 0.6s ease-in-out infinite alternate;
        will-change: box-shadow;
      }
      @keyframes ccNuclearPulse {
        from { box-shadow: 0 0 4px rgba(255,0,0,0.4); }
        to   { box-shadow: 0 0 12px rgba(255,0,0,0.8), 0 0 24px rgba(255,0,0,0.3); }
      }

      #cc-panel {
        width: 340px;
        overflow: hidden;
        opacity: 0;
        clip-path: inset(0 100% 0 0 round 18px);
        will-change: clip-path, opacity;
        transition: clip-path 0.42s cubic-bezier(0.23,1,0.32,1),
                    opacity    0.25s ease;
        pointer-events: none;
        align-self: flex-end;
      }
      #cc-panel.open {
        clip-path: inset(0 0% 0 0 round 18px);
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
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
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
      .cc-metric-val.nuclear,
      .cc-metric-val.black {
        color: #ff0000;
        text-shadow: 0 0 8px rgba(255,0,0,0.6);
        animation: ccNuclearValPulse 0.6s ease-in-out infinite alternate;
        will-change: opacity;
      }
      @keyframes ccNuclearValPulse {
        from { opacity: 1; }
        to   { opacity: 0.65; }
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
        transform: scaleX(1);
        transform-origin: left center;
        transition: transform 0.9s cubic-bezier(0.2,0,0,1);
        will-change: transform;
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
        contain: strict;
      }
      .cc-log::-webkit-scrollbar { width: 3px; }
      .cc-log::-webkit-scrollbar-thumb { background: rgba(221,17,17,0.2); border-radius: 999px; }
      .cc-log-line { color: #dce2eb; }
      .cc-log-line .t  { color: rgba(138,149,165,0.4); }
      .cc-log-line .ok { color: #3fb950; font-weight: 700; }
      .cc-log-line .wn { color: #ff8833; font-weight: 700; }
      .cc-log-line .er { color: #ff3333; font-weight: 700; }
      .cc-log-line .in { color: #00d4ff; font-weight: 700; }
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
          width: min(340px, calc(100vw - 32px));
          max-height: 600px;
          align-self: flex-start;
        }
        .cc-panel-inner {
          width: 100%;
          max-width: min(320px, calc(100vw - 48px));
        }
        .mobile-nav, .mobile-menu, .hamburger-panel, .nav-drawer {
          z-index: 200;
        }
      }

      #cc-overlay.cc-hidden {
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      body.mobile-menu-open #cc-overlay,
      body.menu-open         #cc-overlay,
      body.nav-open          #cc-overlay,
      body.hamburger-open    #cc-overlay {
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

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
  function addLog(tagClass, tag, msg) {
    const timestamp = nowStr();

    state.logEntries.unshift({ time: timestamp, tagClass, tag, msg });
    if (state.logEntries.length > 60) state.logEntries.pop();

    const el = _dom().log;
    if (!el) return;

    const line    = document.createElement("div");
    line.className = "cc-log-line";
    const tSpan   = document.createElement("span");
    tSpan.className = "t";
    tSpan.textContent = timestamp;
    const tagSpan = document.createElement("span");
    tagSpan.className = tagClass;
    tagSpan.textContent = tag;
    const txt = document.createTextNode(" " + msg);
    line.append(tSpan, " ", tagSpan, txt);

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
  ─────────────────────────────────────────────────────────── */
  const SHS_CSS_CLASS = {
    GREEN:  "green",
    YELLOW: "yellow",
    ORANGE: "orange",
    RED:    "red",
    BLACK:  "nuclear",
  };

  const SHS_RECOVER_THRESHOLDS = {
    GREEN:  80,
    YELLOW: 62,
    ORANGE: 42,
    RED:    20,
  };

  const SHS_TO_SIGIL = {
    GREEN:  "GREEN",
    YELLOW: "YELLOW",
    ORANGE: "ORANGE",
    RED:    "RED",
    BLACK:  "BLACK",
  };

  function stepSHSMachine(rho, combinedDrift, ts) {
    const machine = window._orpSHSState;
    const current = machine.currentState;

    if (current === "BLACK") return "BLACK";

    const currentIdx = SHS_STATES.indexOf(current);

    let targetIdx = 0;
    if (rho < 15)      targetIdx = 4;
    else if (rho < 35) targetIdx = 3;
    else if (rho < 55) targetIdx = 2;
    else if (rho < 75) targetIdx = 1;
    else               targetIdx = 0;

    if (state.wardenState === "MANIFEST" && combinedDrift > 0.85) {
      targetIdx = 4;
    }

    if (targetIdx > currentIdx) {
      const newState = SHS_STATES[targetIdx];
      _logSHSTransition(current, newState, ts, "DRIFT");
      machine.currentState     = newState;
      machine.lastTransitionTs = ts;
      machine.stabilityCounter = 0;
      return newState;
    }

    if (targetIdx < currentIdx) {
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
  function _setBarScale(barEl, pct) {
    if (!barEl) return;
    barEl.style.transform = `scaleX(${clamp(pct, 0, 100) / 100})`;
  }

  function update() {
    const d = _dom();

    if (d.ds) d.ds.textContent = fmt4(state.deltaS);

    if (d.rho) { d.rho.textContent = fmt1(state.rho); d.rho.className = "cc-metric-val cyan"; }
    _setBarScale(d.rhoBar, state.rho);
    if (d.rhoBar) d.rhoBar.className = `cc-bar-fill${state.rho < 60 ? " degraded" : ""}`;
    if (d.rhoPct) d.rhoPct.textContent = Math.round(state.rho) + "%";

    const newSHS = window._orpSHSState.currentState;
    if (newSHS !== state.shs) {
      state.shs = newSHS;
    }
    const shsClass = SHS_CSS_CLASS[state.shs] || "green";
    if (d.shs) { d.shs.textContent = state.shs; d.shs.className = `cc-metric-val ${shsClass}`; }
    if (d.pill) { d.pill.textContent = state.shs; d.pill.className = `cc-shs-pill ${shsClass}`; }

    if (d.wpct) {
      const wpct = Math.round(state.warden);
      d.wpct.textContent = wpct + "%";
      d.wpct.className   = `cc-metric-val${state.warden >= 72 ? " red" : state.warden >= 45 ? " orange" : ""}`;
    }
    _setBarScale(d.wBar, state.warden);
    if (d.wPct)  d.wPct.textContent  = Math.round(state.warden) + "%";

    const newW = state.warden >= 72 ? "MANIFEST" : state.warden >= 45 ? "PRIMED" : "DORMANT";
    if (newW !== state.wardenState) {
      addLog(newW === "MANIFEST" ? "er" : newW === "PRIMED" ? "wn" : "ok",
        newW, `W: ${state.wardenState}→${newW}`);
      if (newW === "MANIFEST") addLog("er", "J⊥", "VORTEX — chain locked");
      state.wardenState = newW;
    }
    applyWarden(state.wardenState);

    state.sessionEntropy += state.deltaS * 0.01;
    _debouncedSave();
    if (d.sessionVal) d.sessionVal.textContent = fmt4(state.sessionEntropy);

    /* NESS-SYNC: Persist SHS pressure + Warden flag cross-tab */
    if (window.ORP_SYNC) {
      const shsNow     = window._orpSHSState.currentState;
      const wardenNow  = state.wardenState === 'MANIFEST';
      ORP_SYNC.save('ness_pressure',      shsNow);
      ORP_SYNC.save('ness_warden_active', wardenNow);
    }

    if (d.pageLabel) {
      const pg = window.location.pathname.split("/").pop() || "index.html";
      d.pageLabel.textContent = pg.replace(".html","").toUpperCase() || "INDEX";
    }

    if (d.asciiPanel) _syncAsciiPanel(state.shs);
  }

  /* ── Inject delta ───────────────────────────────────────── */
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

  /* ──────────────────────────────────────────────────────────
     ASCII panel live sync — preserved from v3.1.0
  ─────────────────────────────────────────────────────────── */
  const ASCII_SHS_STYLE = {
    GREEN:  { color: '#3fb950', glow: 'rgba(63,185,80,0.45)',  char: '~', label: '[= STAR =]',  core: '[ CORE ]' },
    YELLOW: { color: '#ffcc00', glow: 'rgba(255,204,0,0.45)',  char: '≈', label: '[~ STAR ~]',  core: '[ CORE ]' },
    AMBER:  { color: '#ff8833', glow: 'rgba(255,136,51,0.5)',  char: '≈', label: '[≈ STAR ≈]',  core: '[ CORE ]' },
    ORANGE: { color: '#ff8833', glow: 'rgba(255,136,51,0.5)',  char: '≈', label: '[≈ STAR ≈]',  core: '[ CORE ]' },
    RED:    { color: '#ff3333', glow: 'rgba(221,17,17,0.6)',   char: '!', label: '[! STAR !]',  core: '[!CORE!]' },
    BLACK:  { color: '#ff0000', glow: 'rgba(255,0,0,0.8)',     char: '█', label: '[█ DEAD █]',  core: '[!NULL!]' },
  };
  const GLITCH_POOL = ['█','▓','▒','░','╳','╬','╫','╪','║','═','╔','╗'];
  let _asciiFrame   = 0;
  let _lastAsciiSHS = '';

  function _syncAsciiPanel(shs) {
    const panel = _dom().asciiPanel;
    if (!panel || panel.offsetParent === null && !panel.closest('body')) return;

    const key  = ASCII_SHS_STYLE[shs] ? shs : 'GREEN';
    const cfg  = ASCII_SHS_STYLE[key];
    _asciiFrame++;

    const drift = parseFloat(
      _getSigils()[0]?.style.getPropertyValue('--drift-intensity') || '0'
    );

    if (shs !== _lastAsciiSHS) {
      _lastAsciiSHS = shs;
      panel.style.color      = cfg.color;
      panel.style.textShadow = `0 0 6px ${cfg.glow}, 0 0 14px ${cfg.glow.replace(/[\d.]+\)$/, '0.2)')}`;
    }

    const wave      = _buildWave(cfg.char, drift, _asciiFrame);
    const useGlitch = (key === 'RED' || key === 'BLACK') && Math.random() > 0.6;
    const wL        = useGlitch ? _glitchStr('//', drift) : '//';
    const wR        = useGlitch ? _glitchStr('//', drift) : '//';
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
  \\    \\__________/    //
   \\________||________//
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

    /* NESS-SYNC: Apply persisted overlay visibility immediately on load */
    if (window.ORP_SYNC) {
      const visible = ORP_SYNC.load('overlay_visible', true);
      if (visible === false) {
        document.getElementById('cc-overlay')?.classList.add('cc-hidden');
      }
    }

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
    menuObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    if (navElement) {
      menuObserver.observe(navElement, { attributes: true, attributeFilter: ["class"] });
    }

    const d = _dom();
    d.tab?.addEventListener("click", () => {
      state.panelOpen = !state.panelOpen;
      d.panel?.classList.toggle("open", state.panelOpen);
      d.tab.setAttribute("aria-expanded", state.panelOpen ? "true" : "false");
      d.panel?.setAttribute("aria-hidden", state.panelOpen ? "false" : "true");
    });

    document.getElementById("cc-inject")?.addEventListener("click", () => {
      injectDelta(0.025 + Math.random() * 0.055);
    });

    document.getElementById("cc-reset")?.addEventListener("click", () => {
      const machine = window._orpSHSState;
      if (machine.currentState === "BLACK" || state.wardenState === "MANIFEST") {
        addLog("ok", "CRA", "Architect reset initiated…");
        setTimeout(() => {
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

    let lastScrollY = window.scrollY, accum = 0;
    window.addEventListener("scroll", () => {
      window._orpSHSState.lastScrollTs = performance.now();
      const delta = Math.abs(window.scrollY - lastScrollY);
      accum += delta; lastScrollY = window.scrollY;
      if (accum > 150) {
        injectDelta(clamp((accum / 12000) * 0.5, 0.001, 0.035));
        accum = 0;
      }
    }, { passive: true });

    document.addEventListener("click", (e) => {
      window._orpSHSState.lastClickTs = performance.now();
      if (e.target.closest("#cc-overlay")) return;
      injectDelta(0.002 + Math.random() * 0.004);
    });

    /* rAF loop: decay + SHS machine + sigil sync */
    let _lastDecayTs   = 0;
    let _lastSigilTs   = 0;
    let _lastSigilSHS  = '';
    let _lastRafTs     = 0;
    const _FPS_ALPHA   = 0.1;

    /* SYNC-8: throttle sigil_drift ORP_SYNC writes to avoid flooding */
    let _lastDriftWrite   = 0;
    let _lastWrittenDrift = -1;
    const DRIFT_WRITE_INTERVAL_MS = 800;

    function _rafLoop(ts) {
      const rawDelta = _lastRafTs > 0 ? ts - _lastRafTs : 16.67;
      _lastRafTs = ts;

      const machine = window._orpSHSState;
      machine.lastFrameDelta = rawDelta;
      machine.frameRate = machine.frameRate * (1 - _FPS_ALPHA)
                        + (1000 / rawDelta) * _FPS_ALPHA;

      if (rawDelta > 33) {
        const slowness = clamp((rawDelta - 33) / 200, 0, 1);
        machine.perfDriftPressure = clamp(
          machine.perfDriftPressure * 0.95 + slowness * PERF_DRIFT_SCALE,
          0, 1
        );
      } else {
        machine.perfDriftPressure = machine.perfDriftPressure * 0.90;
      }

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
        const lastEventTs = Math.max(machine.lastScrollTs, machine.lastClickTs);
        if (lastEventTs > 0) {
          machine.eventJitter = clamp(ts - lastEventTs, 0, 500);
          machine.jitterDrift = machine.eventJitter > 80
            ? clamp((machine.eventJitter - 80) / 400, 0, 0.15)
            : 0;
        }

        const syntheticDrift = clamp(state.deltaS * 4 + (100 - state.rho) / 100, 0, 1);
        const combinedDrift  = clamp(
          syntheticDrift + machine.perfDriftPressure + machine.jitterDrift,
          0, 1
        );

        const newMachineState = stepSHSMachine(state.rho, combinedDrift, ts);

        if (newMachineState !== state.shs) {
          state.shs = newMachineState;
        }

        _getSigils().forEach(s => {
          s.classList.toggle('high-drift', combinedDrift > 0.55);
        });

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

        if (typeof window.updateSigilDrift === 'function') {
          window.updateSigilDrift(combinedDrift);
        }

        /* SYNC-8: Write combinedDrift back to ORP_SYNC so other pages
           and entropia-sigil.js instances stay in sync.
           Throttled to avoid flooding the storage/event bus. */
        if (window.ORP_SYNC &&
            ts - _lastDriftWrite > DRIFT_WRITE_INTERVAL_MS &&
            Math.abs(combinedDrift - _lastWrittenDrift) > 0.01) {
          ORP_SYNC.save('sigil_drift', parseFloat(combinedDrift.toFixed(3)));
          _lastDriftWrite   = ts;
          _lastWrittenDrift = combinedDrift;
        }

        _lastSigilTs = ts;
      }

      state._rafHandle = requestAnimationFrame(_rafLoop);
    }
    state._rafHandle = requestAnimationFrame(_rafLoop);

    /* SYNC-2 / SYNC-3 / SYNC-4: Signal overlay is live */
    window._orpRafActive      = true;
    window._orpOverlayActive  = true;
    window._orpSHSPill        = _dom().pill;
    window._orpInjectDelta    = injectDelta;

    window.addEventListener('pagehide', () => {
      if (state._rafHandle) { cancelAnimationFrame(state._rafHandle); state._rafHandle = null; }
      if (_saveTimer) { clearTimeout(_saveTimer); saveSessionEntropy(state.sessionEntropy); }
      menuObserver.disconnect();
    }, { once: true });

    applySessionPressure();
    if (_dom().asciiPanel) _syncAsciiPanel('GREEN');

    /* ─────────────────────────────────────────────────────────
       NESS-SYNC + SYNC-7 + SYNC-9 + SYNC-10:
       React to ORP_SYNC changes fired from other tabs/modules.
    ───────────────────────────────────────────────────────── */
    window.addEventListener('orp-settings-update', (e) => {
      if (!e.detail) return;
      const { key, value } = e.detail;

      /* ness_entropy: re-hydrate from another tab */
      if (key === 'ness_entropy' && typeof value === 'number') {
        state.sessionEntropy = value;
        if (_dom().sessionVal) _dom().sessionVal.textContent = fmt4(value);
      }

      /* overlay_visible: show/hide from settings page */
      if (key === 'overlay_visible') {
        const ov = document.getElementById('cc-overlay');
        ov?.classList.toggle('cc-hidden', value === false);
      }

      /* SYNC-7: ness_warden_active — cross-tab Warden state sync.
         If another tab's Warden.js fires (MANIFEST) or clears,
         update this overlay's warden bar immediately. */
      if (key === 'ness_warden_active') {
        if (value === true && state.wardenState !== 'MANIFEST') {
          /* Another tab's Warden fired — pre-load bar to MANIFEST zone */
          if (state.warden < 75) {
            state.warden = 75;
            addLog('er', 'WRD', 'Cross-tab Warden MANIFEST received');
            update();
          }
        } else if (value === false && state.wardenState === 'MANIFEST') {
          /* Another tab reset — step down gracefully */
          state.warden = 30;
          addLog('ok', 'WRD', 'Cross-tab Warden cleared');
          update();
        }
      }

      /* SYNC-9: Coordinator telemetry — log run results in cc-log */
      if (key === 'coordinator_run_id' && value != null) {
        const consensus = window.ORP_SYNC
          ? ORP_SYNC.load('coordinator_last_consensus', null)
          : null;
        const drift = window.ORP_SYNC
          ? ORP_SYNC.load('coordinator_last_drift', null)
          : null;
        if (consensus !== null) {
          const tag = consensus >= 0.7 ? 'ok' : consensus >= 0.4 ? 'wn' : 'er';
          addLog(tag, 'ORC', `run#${value} cns:${consensus} Δ:${drift}`);
        }
      }
    });

    /* SYNC-10: orp-runtime-mode-change — coordinator mode change bridge.
       Logs mode transitions (NOMINAL → DEGRADED → ISOLATED → LOCKDOWN)
       directly to the cc-log so operators see coordinator health here. */
    window.addEventListener('orp-runtime-mode-change', (e) => {
      if (!e.detail) return;
      const { mode, prev, reason } = e.detail;
      const modeTagClass = mode === 'LOCKDOWN' ? 'nx'
                         : mode === 'ISOLATED'  ? 'er'
                         : mode === 'DEGRADED'  ? 'wn'
                         :                        'ok';
      addLog(modeTagClass, 'MODE', `${prev}→${mode} [${reason || 'auto'}]`);
    });

    /* SYNC-9 alt: orp-telemetry-request — direct coordinator telemetry event */
    window.addEventListener('orp-telemetry-request', (e) => {
      if (!e.detail || e.detail.source !== 'orp-coordinator') return;
      const { runId, consensus, drift, weighted } = e.detail;
      const tag = consensus >= 0.7 ? 'ok' : consensus >= 0.4 ? 'wn' : 'er';
      addLog(tag, 'ORC', `run#${runId} w:${weighted} cns:${consensus}`);
    });

    const page = (window.location.pathname.split("/").pop() || "index.html")
      .replace(".html","").toUpperCase();
    addLog("ok", "CC",  `Initialized on ${page}`);
    addLog("in", "J⊥", "VORTEX detection: ENGAGED");
    addLog("ok", "ISO", "Epistemic isolation: NOMINAL");

    /* Log restored state if non-nominal */
    if (window._orpSHSState.currentState !== 'GREEN') {
      addLog("wn", "RST", `State restored: SHS=${window._orpSHSState.currentState}`);
    }

    update();
  }

  /* ── Boot ───────────────────────────────────────────────── */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
