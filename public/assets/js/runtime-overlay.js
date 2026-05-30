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
   ============================================================ */

(() => {
  "use strict";

  /* ── Guard: only one instance per page ─────────────────── */
  if (document.getElementById("cc-overlay")) return;

  /* ── Session entropy persistence ───────────────────────── */
  const SS_KEY            = "orp_session_entropy";
  const loadSessionEntropy = () => parseFloat(sessionStorage.getItem(SS_KEY) || "0");
  const saveSessionEntropy = (v) => sessionStorage.setItem(SS_KEY, String(v));

  /* MEDIUM-5 PATCH: debounced sessionStorage write — max 1 write/second.
     sessionStorage.setItem is synchronous I/O; previously called inside
     update() on every decay/inject/click cycle. Now deferred via setTimeout. */
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

  /* ── Helpers ────────────────────────────────────────────── */
  const clamp  = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmt4   = n => n.toFixed(4);
  const fmt1   = n => n.toFixed(1);
  const nowStr = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

  /* ── Cached DOM refs (populated after buildOverlay) ────── */
  let _domCache = null;

  /* ── Cached sigil NodeList — avoids cold querySelectorAll per rAF tick ── */
  let _sigilCache = null;
  function _getSigils() {
    return _sigilCache || (_sigilCache = document.querySelectorAll('.entropia-sigil'));
  }

  function _dom() {
    if (_domCache) return _domCache;
    // All IDs queried exactly once after injection
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
    // Detect environment to set the correct Console URL
    const isORPContext = window.location.pathname.includes('/ORP');
    const runtimeUrl = isORPContext ? 'runtime.html' : 'https://generalsergal.github.io/ORP/runtime.html';
    const linkTarget = isORPContext ? '' : ' target="_blank" rel="noopener noreferrer"';

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
        contain: layout style paint; /* paint: fixed overlay, nothing overflows; backdrop-filter on children samples below stack, not parent paint boundary */
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
      .cc-shs-pill.amber  { color: #ff8833; border-color: rgba(255,136,51,0.3);  background: rgba(255,136,51,0.08); }
      .cc-shs-pill.red    { color: #ff3333; border-color: rgba(221,17,17,0.35);  background: rgba(221,17,17,0.1); }

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
      .cc-metric-val.orange { color: #ff8833; }
      .cc-metric-val.red    { color: #ff3333; }
      .cc-metric-val.cyan   { color: #00d4ff; }

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
         entropia-sigil.css owns will-change:filter + contain:layout style.
         Adding will-change:transform,opacity here created a conflicting compositor
         layer budget, and transition:transform fought initSigilFloat()'s rAF writes.
         The .high-drift glitch animation is kept but scoped to non-floating sigils
         so it doesn't interfere with the JS-driven hero-bg float. */
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
      }
    `;
    document.head.appendChild(style);
  }

  /* ── Log ────────────────────────────────────────────────── */
  /* MEDIUM-4 PATCH: replaced full O(n) DOM rebuild with single-entry prepend.
     Previous: renderLog() rebuilt all 60 entries into a DocumentFragment on
     every addLog() call — expensive at high entropy (multiple calls/second).
     Now: one new <div> created and prepended; excess tail nodes trimmed.
     State array kept in sync for any consumer that reads logEntries directly. */
  function addLog(tagClass, tag, msg) {
    const timestamp = nowStr();

    // Keep state array in sync (capped at 60)
    state.logEntries.unshift({ time: timestamp, tagClass, tag, msg });
    if (state.logEntries.length > 60) state.logEntries.pop();

    const el = _dom().log;
    if (!el) return;

    // Prepend single new line — one DOM node created, one insertion
    const line = document.createElement("div");
    line.className = "cc-log-line";
    line.innerHTML = `<span class="t">${timestamp}</span> <span class="${tagClass}">${tag}</span> ${msg}`;
    el.prepend(line);

    // Trim DOM to match array cap — removes from tail (oldest entry)
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

  /* ── SHS ────────────────────────────────────────────────── */
  function calcSHS(rho) {
    if (rho >= 75) return "GREEN";
    if (rho >= 45) return "AMBER";
    return "RED";
  }
  const SHS_COLOR = { GREEN:"green", AMBER:"amber", RED:"red" };

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

    // SHS — only trigger log + DOM update when it actually changes
    const newSHS = calcSHS(state.rho);
    if (newSHS !== state.shs) {
      addLog(newSHS === "GREEN" ? "ok" : newSHS === "AMBER" ? "wn" : "er",
        "SHS", `${state.shs}→${newSHS}`);
      state.shs = newSHS;
    }
    if (d.shs) { d.shs.textContent = state.shs; d.shs.className = `cc-metric-val ${SHS_COLOR[state.shs]}`; }
    if (d.pill) { d.pill.textContent = state.shs; d.pill.className = `cc-shs-pill ${SHS_COLOR[state.shs]}`; }

    // Warden %
    if (d.wpct) {
      const wpct = Math.round(state.warden);
      d.wpct.textContent = wpct + "%";
      d.wpct.className   = `cc-metric-val${state.warden >= 72 ? " red" : state.warden >= 45 ? " orange" : ""}`;
    }
    if (d.wBar)  d.wBar.style.width  = clamp(state.warden, 0, 100) + "%";
    if (d.wPct)  d.wPct.textContent  = Math.round(state.warden) + "%";

    // Warden state machine
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
    _debouncedSave(); // MEDIUM-5 PATCH: debounced — max 1 sessionStorage write/second
    if (d.sessionVal) d.sessionVal.textContent = fmt4(state.sessionEntropy);

    // Page label
    if (d.pageLabel) {
      const pg = window.location.pathname.split("/").pop() || "index.html";
      d.pageLabel.textContent = pg.replace(".html","").toUpperCase() || "INDEX";
    }

    // MEDIUM-3 PATCH: guard _syncAsciiPanel — only call when the panel exists.
    // update() fires on every injectDelta, decay, and button press; no reason
    // to pay the string-build cost on the ~90% of pages with no ASCII panel.
    if (_dom().asciiPanel) _syncAsciiPanel(state.shs);
  }

  /* ── Inject delta ───────────────────────────────────────── */
  function injectDelta(ds) {
    state.deltaS = clamp(ds, 0, 0.25);
    state.rho    = clamp(state.rho    - ds * 160, 0, 100);
    state.warden = clamp(state.warden + ds * 300, 0, 100);
    addLog("in", "INF", `ΔS:${fmt4(ds)} ρ:${fmt1(state.rho)}`);
    update();
  }

  /* ── Passive decay ──────────────────────────────────────── */
  function decay() {
    if (state.wardenState === "MANIFEST") return;
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
    AMBER:  { color: '#ff8833', glow: 'rgba(255,136,51,0.5)',  char: '≈', label: '[≈ STAR ≈]',  core: '[ CORE ]' },
    RED:    { color: '#ff3333', glow: 'rgba(221,17,17,0.6)',   char: '!', label: '[! STAR !]',  core: '[!CORE!]' },
  };
  const GLITCH_POOL = ['█','▓','▒','░','╳','╬','╫','╪','║','═','╔','╗'];
  let _asciiFrame  = 0;
  let _lastAsciiSHS = '';  // guard: skip full rebuild when SHS hasn't changed AND drift is stable

  function _syncAsciiPanel(shs) {
    const panel = _dom().asciiPanel;
    if (!panel) return;

    const key  = (shs === 'AMBER') ? 'AMBER' : (shs === 'RED') ? 'RED' : 'GREEN';
    const cfg  = ASCII_SHS_STYLE[key];
    _asciiFrame++;

    // MEDIUM-2 PATCH: use memoized _getSigils() instead of cold querySelector
    const drift = parseFloat(
      _getSigils()[0]?.style.getPropertyValue('--drift-intensity') || '0'
    );

    // Only update glow / color strings when SHS state changes — not every tick
    if (shs !== _lastAsciiSHS) {
      _lastAsciiSHS = shs;
      panel.style.color      = cfg.color;
      panel.style.textShadow = `0 0 6px ${cfg.glow}, 0 0 14px ${cfg.glow.replace(/[\d.]+\)$/, '0.2)')}`;
    }

    const wave  = _buildWave(cfg.char, drift, _asciiFrame);
    const wL    = (key === 'RED' && Math.random() > 0.6) ? _glitchStr('//', drift) : '//';
    const wR    = (key === 'RED' && Math.random() > 0.6) ? _glitchStr('//', drift) : '//';
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

    // Mobile menu sync — hide overlay when hamburger is open
    // LOW-3 PATCH: stored as let (was const) so pagehide handler can call .disconnect()
    const overlay = document.getElementById("cc-overlay");
    const menuObserver = new MutationObserver(() => {
      const menuOpen = document.body.classList.contains("mobile-menu-open");
      overlay?.classList.toggle("cc-hidden", menuOpen);
      if (menuOpen && state.panelOpen) {
        state.panelOpen = false;
        const d = _dom();
        d.panel?.classList.remove("open");
        d.tab?.setAttribute("aria-expanded", "false");
        d.panel?.setAttribute("aria-hidden", "true");
      }
    });
    menuObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

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

    // Reset button
    document.getElementById("cc-reset")?.addEventListener("click", () => {
      if (state.wardenState === "MANIFEST") {
        addLog("ok", "CRA", "Recovery sequence initiated…");
        setTimeout(() => {
          state.rho = 85; state.warden = 0; state.deltaS = 0;
          saveSessionEntropy(state.sessionEntropy * 0.5);
          state.sessionEntropy = loadSessionEntropy();
          addLog("ok", "CRA", "Chain restored — Warden deactivated");
          update();
        }, 1000);
      } else {
        state.rho = 100; state.warden = 0; state.deltaS = 0;
        addLog("ok", "OK", "Baseline reset — metrics nominal");
        update();
      }
    });

    // Scroll → entropy (passive, no DOM writes in listener)
    let lastY = window.scrollY, accum = 0;
    window.addEventListener("scroll", () => {
      const delta = Math.abs(window.scrollY - lastY);
      accum += delta; lastY = window.scrollY;
      if (accum > 150) {
        injectDelta(clamp((accum / 12000) * 0.5, 0.001, 0.035));
        accum = 0;
      }
    }, { passive: true });

    // Click entropy
    document.addEventListener("click", (e) => {
      if (e.target.closest("#cc-overlay")) return;
      injectDelta(0.002 + Math.random() * 0.004);
    });

    /* ── rAF-capped decay + sigil sync loop ─────────────────
       Decay fires every ~900ms; sigil+ASCII sync every ~800ms.
       All writes are batched here — no setInterval in this file.
    ─────────────────────────────────────────────────────────── */
    let _lastDecayTs  = 0;
    let _lastSigilTs  = 0;
    let _lastSigilSHS = '';

    function _rafLoop(ts) {
      /* MEDIUM-1 PATCH: early-exit when neither decay nor sigil-sync is due.
         Without this, all timestamp comparisons + _dom().pill dereference ran
         at full display refresh rate (60–120 wakeups/sec) doing nothing useful. */
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
        const pill = _dom().pill;
        if (pill) {
          const shs = pill.textContent.trim().toUpperCase();
          if (shs && shs !== _lastSigilSHS) {
            _lastSigilSHS = shs;
            if (typeof window.updateSigilFromSHS === 'function') {
              window.updateSigilFromSHS(shs === 'AMBER' ? 'YELLOW' : shs);
            }
            if (_dom().asciiPanel) _syncAsciiPanel(shs); // MEDIUM-3: guard here too
          }
        }

        const drift = clamp(state.deltaS * 4 + (100 - state.rho) / 100, 0, 1);
        _getSigils().forEach(s => {
          s.classList.toggle('high-drift', drift > 0.55);
        });

        _lastSigilTs = ts;
      }

      state._rafHandle = requestAnimationFrame(_rafLoop);
    }
    state._rafHandle = requestAnimationFrame(_rafLoop);
    window._orpRafActive = true; // signal to entropia-sigil.js: its setInterval is suppressed

    /* LOW-1 + LOW-3 PATCH: cancel rAF and disconnect observers on page unload.
       Prevents ghost loops in bfcache / Turbo Drive / SPA navigation. */
    window.addEventListener('pagehide', () => {
      if (state._rafHandle) { cancelAnimationFrame(state._rafHandle); state._rafHandle = null; }
      if (_saveTimer) { clearTimeout(_saveTimer); saveSessionEntropy(state.sessionEntropy); }
      menuObserver.disconnect();
    }, { once: true });

    applySessionPressure();
    if (_dom().asciiPanel) _syncAsciiPanel('GREEN'); // MEDIUM-3: guard init call too

    const page = (window.location.pathname.split("/").pop() || "index.html")
      .replace(".html","").toUpperCase();
    addLog("ok", "CC", `Initialized on ${page}`);
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
