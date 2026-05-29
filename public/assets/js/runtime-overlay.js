/* ============================================================
   ORP v3.0 — Clinical Core: Global Runtime Overlay
   runtime-overlay.js

   Drop <script src="assets/js/runtime-overlay.js"></script>
   in every page AFTER main.js. This file:
     1. Injects the NESS HUD into the DOM on every page
     2. Binds scroll + click entropy to the NESS engine
     3. Persists cumulative session entropy via sessionStorage
     4. Manages Warden state across the whole site
   ============================================================ */

(() => {
  "use strict";

  /* ── Guard: only one instance per page ─────────────────── */
  if (document.getElementById("cc-overlay")) return;

  /* ── Session entropy persistence ───────────────────────── */
  const SS_KEY = "orp_session_entropy";
  const loadSessionEntropy = () => parseFloat(sessionStorage.getItem(SS_KEY) || "0");
  const saveSessionEntropy = (v) => sessionStorage.setItem(SS_KEY, String(v));

  /* ── State ──────────────────────────────────────────────── */
  const state = {
    deltaS:         0,
    rho:            100,
    warden:         0,
    wardenState:    "DORMANT",
    shs:            "GREEN",
    dsHistory:      [],
    logEntries:     [],
    sessionEntropy: loadSessionEntropy(),
    scrollAccum:    0,
    lastScrollY:    window.scrollY,
    panelOpen:      false,
    decayTimer:     null,
  };

  /* ── Helpers ────────────────────────────────────────────── */
  const clamp  = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmt4   = n => n.toFixed(4);
  const fmt1   = n => n.toFixed(1);
  const nowStr = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

  /* ── Inject overlay HTML ────────────────────────────────── */
  function buildOverlay() {
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
            <a href="runtime.html" class="cc-btn cc-btn-link">[ FULL CONSOLE ]</a>
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
      /* ── Overlay container ─────────────────────────── */
      #cc-overlay {
        position: fixed;
        bottom: 24px;
        left: 24px;
        /* lowered default desktop stack */
        z-index: 1200;
        display: flex;
        flex-direction: row;
        align-items: flex-end;
        gap: 10px;
        pointer-events: none;
        font-family: "Oxanium", "Space Grotesk", sans-serif;
        /* GPU: promote overlay to own layer so panel open/close
           doesn't trigger full-page compositing */
        contain: layout style;
        transform: translateZ(0);
        transition:
          opacity 180ms ease,
          visibility 180ms ease,
          transform 180ms ease;
      }
      #cc-overlay * {
        pointer-events: auto; /* interactive children catch events */
        box-sizing: border-box;
      }

      /* ── Toggle tab ────────────────────────────────── */
      #cc-tab {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 7px 14px;
        background: rgba(15,18,23,0.92);
        border: 1px solid rgba(221,17,17,0.25);
        border-radius: 999px;
        color: #dce2eb;
        font-family: "Oxanium", sans-serif;
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.1em;
        cursor: pointer;
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        transition: border-color 250ms ease, background 250ms ease, transform 250ms ease;
        box-shadow: 0 4px 20px rgba(0,0,0,0.6);
        margin-top: 0;
        align-self: flex-end;
      }
      #cc-tab:hover {
        border-color: rgba(255,102,0,0.5);
        background: rgba(22,26,34,0.96);
        transform: translateY(-1px);
      }

      /* ── Animated dot ──────────────────────────────── */
      .cc-dot {
        display: inline-block;
        width: 7px; height: 7px;
        border-radius: 50%;
        background: #3fb950;
        flex-shrink: 0;
        position: relative;          /* anchor for ::after pulse ring */
        animation: ccDotFade 2s ease infinite;
        will-change: opacity;
      }
      .cc-dot.orange { background: #ff6600; animation-delay: 0.4s; }
      .cc-dot.red    { background: #ff3333; animation-delay: 0.8s; }

      /* Pulse ring — scale+opacity only (GPU composited, no paint) */
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

      /* ── SHS pill in tab ───────────────────────────── */
      .cc-shs-pill {
        font-size: 0.6rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        padding: 2px 7px;
        border-radius: 999px;
        border: 1px solid;
      }
      .cc-shs-pill.green  { color: #3fb950; border-color: rgba(63,185,80,0.3); background: rgba(63,185,80,0.08); }
      .cc-shs-pill.amber  { color: #ff8833; border-color: rgba(255,136,51,0.3); background: rgba(255,136,51,0.08); }
      .cc-shs-pill.red    { color: #ff3333; border-color: rgba(221,17,17,0.35); background: rgba(221,17,17,0.1); }

      /* ── Panel ─────────────────────────────────────── */
      #cc-panel {
        width: 320px;
        max-width: 0;
        overflow: hidden;
        transition: max-width 0.38s cubic-bezier(0.2,0,0,1), opacity 0.25s ease;
        opacity: 0;
        pointer-events: none;
        align-self: flex-end;
      }
      #cc-panel.open {
        max-width: 340px;
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
        margin-bottom: 0;
        margin-top: 0;
      }

      /* ── Panel header ──────────────────────────────── */
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

      /* ── Metrics row ───────────────────────────────── */
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

      /* ── Bar rows ──────────────────────────────────── */
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
        /* NOTE: will-change:width causes layout — omit it intentionally.
           The bar is narrow; transition cost is negligible. */
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

      /* ── Warden row ────────────────────────────────── */
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
      .cc-badge.dormant  { color: #3fb950; border-color: rgba(63,185,80,0.3); background: rgba(63,185,80,0.08); }
      .cc-badge.primed   { color: #ff8833; border-color: rgba(255,136,51,0.3); background: rgba(255,136,51,0.08); }
      .cc-badge.manifest { color: #ff3333; border-color: rgba(221,17,17,0.4); background: rgba(221,17,17,0.1); }

      /* ── Session entropy ───────────────────────────── */
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

      /* ── Mini log ──────────────────────────────────── */
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

      /* ── Controls ──────────────────────────────────── */
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

      /* ── Mobile: pin to bottom-left, panel opens upward ──── */
      @media (max-width: 640px) {
        #cc-overlay {
          bottom: 24px;          /* same row as scroll-top (right side) — no conflict */
          left: 12px;
          right: auto;           /* don't stretch across — stay left-pinned */
          flex-direction: column-reverse;
          align-items: flex-start;
          z-index: 40;
          max-width: calc(100vw - 24px);
        }
		#cc-tab {
          /* Slightly smaller pill on mobile to save space */
          padding: 6px 12px;
          font-size: 0.68rem;
          /* FIX: Override desktop align-end, force button to the left */
          align-self: flex-start; 
        }
        #cc-panel {
          max-width: none;
          width: calc(100vw - 24px); /* full width minus left margin */
          /* FIX: Anchor panel to the left so it opens rightward */
          align-self: flex-start; 
        }
        #cc-panel.open {
          max-width: min(360px, calc(100vw - 32px));
          max-height: 600px;
        }
        .cc-panel-inner {
          width: 100%;
          max-width: 360px;
        }
        /* your mobile nav/hamburger should exceed overlay */
        .mobile-nav,
        .mobile-menu,
        .hamburger-panel,
        .nav-drawer {
          z-index: 200;
        }
      }

      /* ── Explicit hidden state ───────────────────────── */
      #cc-overlay.cc-hidden {
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
        transform: translateY(12px);
      }

      /* ── Reduced motion ────────────────────────────── */
      @media (prefers-reduced-motion: reduce) {
        .cc-dot, #cc-tab { animation: none !important; transition: none !important; }
        #cc-panel { transition: none !important; }
        .cc-bar-fill { transition: none !important; }
      }
    `;
    document.head.appendChild(style);
  }

  /* ── Log ────────────────────────────────────────────────── */
  function addLog(tagClass, tag, msg) {
    const entry = { time: nowStr(), tagClass, tag, msg };
    state.logEntries.unshift(entry);
    if (state.logEntries.length > 60) state.logEntries.pop();
    renderLog();
  }

  function renderLog() {
    const el = document.getElementById("cc-log");
    if (!el) return;
    el.innerHTML = state.logEntries
      .map(e => `<div class="cc-log-line"><span class="t">${e.time}</span> <span class="${e.tagClass}">${e.tag}</span> ${e.msg}</div>`)
      .join("");
  }

  /* ── Warden config ──────────────────────────────────────── */
  const WARDEN = {
    DORMANT:  { cls:"dormant",  icon:"⬡", title:"Warden — DORMANT",   desc:"No drift detected. Epistemic isolation nominal." },
    PRIMED:   { cls:"primed",   icon:"◈", title:"Warden — PRIMED",    desc:"Entropy accumulating. J⊥ detection elevated." },
    MANIFEST: { cls:"manifest", icon:"⛒", title:"Warden — MANIFEST",  desc:"Threshold exceeded. CRA validation in progress." },
  };

  function applyWarden(s) {
    const cfg = WARDEN[s];
    const icon  = document.getElementById("cc-warden-icon");
    const title = document.getElementById("cc-warden-title");
    const desc  = document.getElementById("cc-warden-desc");
    const badge = document.getElementById("cc-warden-badge");
    const row   = document.getElementById("cc-warden-row");
    if (!icon) return;
    icon.textContent   = cfg.icon;
    title.textContent  = cfg.title;
    desc.textContent   = cfg.desc;
    badge.textContent  = s;
    badge.className    = `cc-badge ${cfg.cls}`;
    row.className      = `cc-warden-row${s === "MANIFEST" ? " alert" : ""}`;
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
    const g = id => document.getElementById(id);

    // ΔS
    const dsEl = g("cc-ds");
    if (dsEl) dsEl.textContent = fmt4(state.deltaS);

    // ρ(x)
    const rhoEl = g("cc-rho");
    if (rhoEl) { rhoEl.textContent = fmt1(state.rho); rhoEl.className = `cc-metric-val cyan`; }
    const rhoBar = g("cc-rho-bar");
    if (rhoBar) {
      rhoBar.style.width = clamp(state.rho, 2, 100) + "%";
      rhoBar.className   = `cc-bar-fill${state.rho < 60 ? " degraded" : ""}`;
    }
    const rhoPct = g("cc-rho-pct");
    if (rhoPct) rhoPct.textContent = Math.round(state.rho) + "%";

    // SHS
    const newSHS = calcSHS(state.rho);
    if (newSHS !== state.shs) {
      addLog(newSHS === "GREEN" ? "ok" : newSHS === "AMBER" ? "wn" : "er",
        "SHS", `${state.shs}→${newSHS}`);
      state.shs = newSHS;
    }
    const shsEl = g("cc-shs");
    if (shsEl) { shsEl.textContent = state.shs; shsEl.className = `cc-metric-val ${SHS_COLOR[state.shs]}`; }
    // Tab pill
    const pill = g("cc-tab-shs");
    if (pill) { pill.textContent = state.shs; pill.className = `cc-shs-pill ${SHS_COLOR[state.shs]}`; }

    // Warden %
    const wEl  = g("cc-wpct");
    if (wEl) {
      const wpct = Math.round(state.warden);
      wEl.textContent = wpct + "%";
      wEl.className   = `cc-metric-val${state.warden >= 72 ? " red" : state.warden >= 45 ? " orange" : ""}`;
    }
    const wBar = g("cc-w-bar");
    if (wBar) wBar.style.width = clamp(state.warden, 0, 100) + "%";
    const wPct = g("cc-w-pct");
    if (wPct) wPct.textContent = Math.round(state.warden) + "%";

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
    saveSessionEntropy(state.sessionEntropy);
    const seEl = g("cc-session-val");
    if (seEl) seEl.textContent = fmt4(state.sessionEntropy);

    // Page label
    const pageEl = g("cc-page-label");
    if (pageEl) {
      const pg = window.location.pathname.split("/").pop() || "index.html";
      pageEl.textContent = pg.replace(".html","").toUpperCase() || "INDEX";
    }
  }

  /* ── Inject delta ───────────────────────────────────────── */
  function injectDelta(ds) {
    state.deltaS  = clamp(ds, 0, 0.25);
    state.rho     = clamp(state.rho - ds * 160, 0, 100);
    state.warden  = clamp(state.warden + ds * 300, 0, 100);
    addLog("in", "INF", `ΔS:${fmt4(ds)} ρ:${fmt1(state.rho)}`);
    update();
  }

  /* ── Passive decay ──────────────────────────────────────── */
  function decay() {
    if (state.wardenState === "MANIFEST") return;
    state.rho    = clamp(state.rho    + 0.10, 0, 100);
    state.warden = clamp(state.warden - 0.40, 0, 100);
    state.deltaS = clamp(state.deltaS - 0.0001, 0, 1);
    update();
  }

  /* ── Session entropy → Warden pre-load ─────────────────── */
  // If the user has accumulated significant session entropy across
  // pages, pre-heat the Warden activation percentage.
  function applySessionPressure() {
    const pressure = clamp(state.sessionEntropy / 500, 0, 1);
    if (pressure > 0.05) {
      state.warden = clamp(pressure * 65, 0, 65); // max 65% from session (below trigger)
      state.rho    = clamp(100 - pressure * 40, 60, 100);
      addLog("wn", "SES", `Session pressure: ${(pressure * 100).toFixed(0)}%`);
      update();
    }
  }

  /* ── Init ───────────────────────────────────────────────── */
  function init() {
    buildStyles();
    buildOverlay();

    // ── Mobile menu sync observer ─────────────────────
    const overlay = document.getElementById("cc-overlay");
    const menuObserver = new MutationObserver(() => {
      const menuOpen = document.body.classList.contains("mobile-menu-open");
      overlay?.classList.toggle("cc-hidden", menuOpen);
      if (menuOpen && state.panelOpen) {
        state.panelOpen = false;
        const panel = document.getElementById("cc-panel");
        const tab   = document.getElementById("cc-tab");
        panel?.classList.remove("open");
        tab?.setAttribute("aria-expanded", "false");
        panel?.setAttribute("aria-hidden", "true");
      }
    });
    menuObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"]
    });

    // Tab toggle
    const tab   = document.getElementById("cc-tab");
    const panel = document.getElementById("cc-panel");
    tab?.addEventListener("click", () => {
      state.panelOpen = !state.panelOpen;
      panel?.classList.toggle("open", state.panelOpen);
      tab.setAttribute("aria-expanded", state.panelOpen ? "true" : "false");
      panel?.setAttribute("aria-hidden", state.panelOpen ? "false" : "true");
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

    // Scroll → entropy
    let lastY = window.scrollY, accum = 0;
    window.addEventListener("scroll", () => {
      const delta = Math.abs(window.scrollY - lastY);
      accum += delta; lastY = window.scrollY;
      if (accum > 150) {
        injectDelta(clamp((accum / 12000) * 0.5, 0.001, 0.035));
        accum = 0;
      }
    }, { passive: true });

    // Click entropy (light weight — 1 click = tiny ΔS)
    document.addEventListener("click", (e) => {
      if (e.target.closest("#cc-overlay")) return; // ignore own UI
      injectDelta(0.002 + Math.random() * 0.004);
    });

    // Passive decay loop
    state.decayTimer = setInterval(decay, 900);

    // Apply cross-page session pressure
    applySessionPressure();

    // Initial log
    const page = (window.location.pathname.split("/").pop() || "index.html").replace(".html","").toUpperCase();
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