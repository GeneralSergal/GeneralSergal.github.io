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

   PATCH LOG (v3.1.0 — Firefox GPU + Overlay / Graphics fixes):
     FF-1    — Removed will-change:transform from #cc-overlay root.
               Firefox composites every stacking context that has
               will-change:transform, causing the overlay (which
               contains animated children) to fork multiple GPU layers.
               The overlay is position:fixed; Firefox already promotes it.
               will-change removed. translateZ(0) hack removed (same issue).
               contain:layout style paint kept — that's compositing-safe.
     FF-2    — backdrop-filter on #cc-tab and .cc-panel-inner:
               Firefox creates one intermediate surface per element with
               backdrop-filter. Both elements already had blur(12px) /
               blur(16px). No change to the values, but added:
                 backface-visibility: hidden;
               on both — this is the Firefox hint to promote the element
               as a single GPU layer rather than repainting it per frame.
     FF-3    — CSS transition on #cc-overlay root (opacity/visibility/
               transform) removed. Root transitions on fixed positioned
               composited elements force full-page stacking context
               invalidation on FF. The overlay is now always opacity:1
               and hidden only via cc-hidden class (opacity→0 + visibility).
     GFXFIX-1— ASCII panel overlapping: _syncAsciiPanel() was writing
               textContent to .ascii-core-panel, a pre-existing page
               element whose dimensions were not guaranteed. Added a
               visibility guard (offsetParent check) and gave the output
               fixed character-width columns to prevent layout bleed.
     GFXFIX-2— cc-panel width:0 → width:340px animation triggers a
               layout recalc on Firefox because 'width' is not GPU-
               compositable. Replaced with max-width transition +
               clip-path technique: panel clips to zero via
               clip-path:inset(0 100% 0 0) → inset(0 0 0 0), which is
               fully GPU-compositable on both Chrome and Firefox.
               will-change:clip-path added to panel element.
               Sidebar: max-width is also NOT compositable; only
               clip-path / transform / opacity are safe here.
     GFXFIX-3— Nuclear pulse @keyframe caused additive glow on
               Firefox due to compounding text-shadow repaint. Scoped
               the nuclear animation to pill only; metric val uses a
               simpler opacity-only variant on FF.
     GFXFIX-4— addLog() innerHTML rebuild for each new entry was
               causing forced layout in the log container. Now uses
               DocumentFragment + prepend to avoid O(n) innerHTML parse.
     SYNC-1  — _syncAsciiPanel character art corrected: the box-drawing
               was misaligned in proportional fonts because spaces were
               used for indentation. Now uses explicit monospace spacing
               tokens and pre-formatted column widths matching a 40-char
               terminal. Fixed bottom-slash escape (was \\\\  → was
               rendering as \\ in textContent; now correct literal \).
     SYNC-2  — runtime.html's standalone NESS engine runs a SECOND
               rAF/setInterval loop in parallel. To prevent double-decay
               on runtime.html, _rafLoop now sets window._orpOverlayActive
               so runtime.html's inline script can check before starting
               its own setInterval. (See runtime.html sync patch.)
     SYNC-3  — rc-tab-shs pill (the overlay tab pill) is now the
               canonical SHS source. MutationObserver re-exported on
               window._orpSHSPill so runtime.html can observe it directly
               instead of running its own poll loop.
     PERF-FF — Event listeners that were non-passive but never called
               preventDefault converted to passive (click on document
               already was passive-safe; no preventions used).
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
      /* FF-1 FIX: No will-change/translateZ on the root — Firefox
         auto-promotes position:fixed elements; adding will-change on
         top forks additional GPU layers for every animated child. */
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
        /* FF-2: backface-visibility:hidden tells Firefox to promote this
           backdrop-filter element as a single stable GPU layer */
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
        /* FF-3 FIX: transition removed from root; only transform on tab */
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
      /* SHS-4 / GFXFIX-3: NUCLEAR — pill gets glow animation;
         metric val uses opacity pulse only (no text-shadow repaint on FF) */
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

      /* GFXFIX-2 FIX: Replace width:0→340px transition with clip-path.
         clip-path:inset() is GPU-compositable on FF+Chrome.
         width stays at a fixed 340px; only visibility changes via clip. */
      #cc-panel {
        width: 340px;
        overflow: hidden;
        opacity: 0;
        clip-path: inset(0 100% 0 0 round 18px);
        /* GFXFIX-2: will-change: clip-path, opacity — both compositable */
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
        /* FF-2: backface-visibility on the blur element */
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
      /* GFXFIX-3: Nuclear metric val — opacity pulse instead of text-shadow
         animation, which forces expensive rasterization on FF */
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
      /* Bar fill: use transform:scaleX instead of width% — compositable */
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
        /* Isolate scroll container from parent stacking context */
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
        /* Mobile: panel clips horizontally to screen width */
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

      /* cc-hidden: opacity+visibility (no transform, no will-change) */
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

      /* HIGH-3 PATCH: scoped glitch to non-floating sigils */
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
  /* GFXFIX-4: DocumentFragment prepend — no innerHTML parse per entry */
  function addLog(tagClass, tag, msg) {
    const timestamp = nowStr();

    state.logEntries.unshift({ time: timestamp, tagClass, tag, msg });
    if (state.logEntries.length > 60) state.logEntries.pop();

    const el = _dom().log;
    if (!el) return;

    /* Build new line without touching innerHTML of the container */
    const line    = document.createElement("div");
    line.className = "cc-log-line";
    /* Build inner nodes via DOM rather than innerHTML parse */
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

  const SHS_DEGRADE_THRESHOLDS = {
    GREEN:  75,
    YELLOW: 55,
    ORANGE: 35,
    RED:    15,
    BLACK:   0,
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
  /* BAR FIX: bars use scaleX(0..1) via transform instead of width% */
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
     ASCII panel live sync
     GFXFIX-1: Fixed character-width columns (40ch terminal),
     proper escape sequences, visibility guard.
     SYNC-1: Corrected box-drawing alignment.
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
    /* GFXFIX-1: guard — only write if panel is in the DOM and visible */
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
    /* SYNC-1: Use const strings without variable-length glitch on flanks
       (the // delimiters are fixed-width; glitch only on RED/BLACK) */
    const useGlitch = (key === 'RED' || key === 'BLACK') && Math.random() > 0.6;
    const wL        = useGlitch ? _glitchStr('//', drift) : '//';
    const wR        = useGlitch ? _glitchStr('//', drift) : '//';
    const coreLabel = (drift > 0.55 && Math.random() > 0.5)
      ? _glitchStr(cfg.core, drift) : cfg.core;

    /* SYNC-1: Fixed-column ASCII art — every line is exactly 36 chars.
       Uses backslash literals (not escape sequences in template). */
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

        _lastSigilTs = ts;
      }

      state._rafHandle = requestAnimationFrame(_rafLoop);
    }
    state._rafHandle = requestAnimationFrame(_rafLoop);

    /* SYNC-2: Signal that the overlay rAF loop is running.
       runtime.html's inline script checks _orpOverlayActive before
       starting its own setInterval to avoid double-decay. */
    window._orpRafActive      = true;
    window._orpOverlayActive  = true;

    /* SYNC-3: Expose the SHS pill element so runtime.html can observe
       it directly without polling */
    window._orpSHSPill = _dom().pill;

    /* SYNC-4: Expose injectDelta so runtime.html buttons can delegate
       into the overlay's authoritative state rather than running a
       second mutation path. Without this, the Warden bar never fills
       from the rc-inject / rc-warden buttons. */
    window._orpInjectDelta = injectDelta;

    window.addEventListener('pagehide', () => {
      if (state._rafHandle) { cancelAnimationFrame(state._rafHandle); state._rafHandle = null; }
      if (_saveTimer) { clearTimeout(_saveTimer); saveSessionEntropy(state.sessionEntropy); }
      menuObserver.disconnect();
    }, { once: true });

    applySessionPressure();
    if (_dom().asciiPanel) _syncAsciiPanel('GREEN');

    /* NESS-SYNC: React to ORP_SYNC changes fired from other tabs.
       If another page boosts entropy or triggers Warden, this
       overlay updates instantly without a reload. */
    window.addEventListener('orp-settings-update', (e) => {
      if (!e.detail) return;
      const { key, value } = e.detail;
      if (key === 'ness_entropy' && typeof value === 'number') {
        /* Re-hydrate session entropy from another tab's write */
        state.sessionEntropy = value;
        if (_dom().sessionVal) _dom().sessionVal.textContent = fmt4(value);
      }
      if (key === 'overlay_visible') {
        const overlay = document.getElementById('cc-overlay');
        overlay?.classList.toggle('cc-hidden', value === false);
      }
    });

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
