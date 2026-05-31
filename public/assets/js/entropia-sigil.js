/* ============================================================
   ENTROPIA SIGIL — JavaScript Module
   ORP Δ v3.2.1 | entropia-sigil.js

   DROP-IN: Add <script src="assets/js/entropia-sigil.js"></script>
   to your page's <body> end, AFTER main.js and runtime-overlay.js.

   PUBLIC API:
     updateSigilDrift(0.0–1.0)       — set by numeric drift score
     updateSigilFromSHS('GREEN')      — set by SHS state string
     setSigilMotion({ ease, idleMs, maxLean, float })  — runtime params

   RUNTIME GLOBALS (settable via ORP_SYNC or direct assignment):
     window.SIGIL_EASE      — LERP smoothing factor (default 0.03)
     window.SIGIL_IDLE_MS   — ms idle before drift-back (default 3000)
     window.SIGIL_MAX_LEAN  — max px displacement (default 45)

   PATCH LOG (v3.2.1 — Warden Unleashed Update):
     MOTION-1  — Replaced full-viewport Lissajous with mouse-tracking LERP.
                 Sigil follows cursor with dampened, viscous lag.
     MOTION-2  — SHS-driven motion personality:
                   GREEN  → EASE 0.02, IDLE 4000, MAX_LEAN 30  (steady)
                   YELLOW → EASE 0.04, IDLE 2500, MAX_LEAN 50  (restless)
                   ORANGE → EASE 0.06, IDLE 1500, MAX_LEAN 65  (agitated)
                   RED    → EASE 0.10, IDLE 800,  MAX_LEAN 90  (hunter)
                   BLACK  → EASE 0.015,IDLE 5000, MAX_LEAN 120 (maximum reach, slow)
     MOTION-3  — Viewport-edge clamping: sigil never exits visible area.
     MOTION-4  — Top-right anchor: default spawn position upper-right quadrant.
     MOTION-5  — setSigilMotion(params) public API for runtime config.
     MOTION-6  — EASE, IDLE_MS, MAX_LEAN exposed as window globals for ORP_SYNC.
     MOTION-7  — WARDEN UNLEASHED: When MAX_LEAN >= 90 (RED/BLACK states), the 
                 dampening leash is removed. The sigil will fully track the cursor
                 across the entire viewport. Wrapper appended to document.body to 
                 escape CSS transform containing-block traps.
     FF-1      — FF-1 fix preserved: transform on .es-float-wrapper wrapper div.
     FF-2/3    — Firefox GPU layer guards preserved.
     PERF-1    — rAF timestamp accumulator pattern (no Date.now() in hot path).
     PERF-2    — Single style.transform string per tick; toFixed(1).
     LOW-1     — pagehide cancels rAF, disconnects ResizeObserver.
   ============================================================ */

(function (global) {
  'use strict';

  /* ── SHS → numeric drift map ─────────────────────────────── */
  const SHS_DRIFT_MAP = {
    'GREEN':  0.00,
    'YELLOW': 0.25,
    'ORANGE': 0.55,
    'RED':    0.78,
    'BLACK':  1.00,
  };

  /* ── SHS → motion personality profiles (MOTION-2) ───────── */
  const SHS_MOTION_MAP = {
    'GREEN':  { ease: 0.02,  idleMs: 4000, maxLean: 30  },
    'YELLOW': { ease: 0.04,  idleMs: 2500, maxLean: 50  },
    'ORANGE': { ease: 0.06,  idleMs: 1500, maxLean: 65  },
    'RED':    { ease: 0.10,  idleMs: 800,  maxLean: 90  },
    'BLACK':  { ease: 0.015, idleMs: 5000, maxLean: 120 },
  };

  /* ── Runtime-settable globals (MOTION-6, ORP_SYNC bridge) ── */
  global.SIGIL_EASE     = global.SIGIL_EASE     ?? 0.03;
  global.SIGIL_IDLE_MS  = global.SIGIL_IDLE_MS  ?? 3000;
  global.SIGIL_MAX_LEAN = global.SIGIL_MAX_LEAN ?? 45;

  /* ── Memoization state ────────────────────────────────────── */
  let _lastIntensity  = -1;
  let _lastSigilCount = 0;
  let _lastGlowDrift  = -1;
  let _lastGlowValue  = '';

  /* ── Cached sigil NodeList ──────────────────────────────── */
  let _sigilCache = null;

  function _getSigils() {
    if (!_sigilCache) _sigilCache = document.querySelectorAll('.entropia-sigil');
    return _sigilCache;
  }

  function _invalidateCache() {
    _sigilCache = null;
  }


  /* ──────────────────────────────────────────────────────────
     updateSigilDrift(driftValue)
     Sets --drift-intensity on every .entropia-sigil element.
  ─────────────────────────────────────────────────────────── */
  function updateSigilDrift(driftValue) {
    const intensity = Math.min(Math.max(parseFloat(driftValue) || 0, 0), 1);
    const sigils    = _getSigils();

    if (intensity === _lastIntensity && sigils.length === _lastSigilCount) return intensity;
    _lastIntensity  = intensity;
    _lastSigilCount = sigils.length;

    const glow = _driftToGlow(intensity);
    sigils.forEach(sigil => {
      sigil.style.setProperty('--drift-intensity', intensity);
      sigil.style.setProperty('--es-shs-glow', glow);
    });

    return intensity;
  }


  /* ──────────────────────────────────────────────────────────
     updateSigilFromSHS(shsState)
     Updates drift AND applies the matching motion profile.
  ─────────────────────────────────────────────────────────── */
  function updateSigilFromSHS(shsState) {
    const key       = (shsState || 'GREEN').trim().toUpperCase();
    const intensity = SHS_DRIFT_MAP[key] ?? 0;

    /* Apply motion profile if one exists for this state */
    const profile = SHS_MOTION_MAP[key];
    if (profile) {
      setSigilMotion(profile);
    }

    return updateSigilDrift(intensity);
  }


  /* ──────────────────────────────────────────────────────────
     setSigilMotion(params)
     PUBLIC API (MOTION-5). Accepts { ease, idleMs, maxLean, float }.
     All keys optional — only provided keys are updated.
     Also syncs to window.SIGIL_* globals for ORP_SYNC visibility.
  ─────────────────────────────────────────────────────────── */
  function setSigilMotion(params) {
    if (!params || typeof params !== 'object') return;
    if (typeof params.ease    === 'number') global.SIGIL_EASE     = params.ease;
    if (typeof params.idleMs  === 'number') global.SIGIL_IDLE_MS  = params.idleMs;
    if (typeof params.maxLean === 'number') global.SIGIL_MAX_LEAN = params.maxLean;
    if (typeof params.float   === 'boolean') {
      /* Toggle float mode — freeze or resume wrapper */
      document.querySelectorAll('.es-float-wrapper').forEach(w => {
        if (!params.float) {
          w.style.transition = 'none';
          w.style.transform  = '';
        } else {
          w.style.transition = '';
        }
      });
    }
  }


  /* ── Internal: compute SHS-aware glow colour ─────────────── */
  function _driftToGlow(intensity) {
    const key = Math.round(intensity * 1000) / 1000;
    if (key === _lastGlowDrift) return _lastGlowValue;
    _lastGlowDrift = key;

    const hue           = 120 - key * 120;
    const [r, g, b]     = _hslToRgbValues(hue / 360, 0.85, 0.5);
    const alpha         = 0.15 + key * 0.30;
    _lastGlowValue      = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
    return _lastGlowValue;
  }


  /* ──────────────────────────────────────────────────────────
     initEntropiaSigils()
     Stamps the SVG from <template id="entropiaSigilTemplate">
     into every empty .entropia-sigil wrapper.
  ─────────────────────────────────────────────────────────── */
  function initEntropiaSigils() {
    const template = document.getElementById('entropiaSigilTemplate');

    if (!template) {
      console.warn('[ORP_SIGIL] <template id="entropiaSigilTemplate"> not found.');
      return;
    }

    let injected = 0;

    document.querySelectorAll('.entropia-sigil').forEach(wrapper => {
      if (wrapper.querySelector('svg')) return;

      const clone = template.content.cloneNode(true);
      const uid   = Math.random().toString(36).slice(2, 7);
      const svgEl = clone.querySelector('svg');

      if (svgEl) {
        const idPairs = [
          ['esGlowCore',  `esGlowCore_${uid}`],
          ['esGlowOuter', `esGlowOuter_${uid}`],
          ['esGlowCyan',  `esGlowCyan_${uid}`],
          ['esGlowSoft',  `esGlowSoft_${uid}`],
          ['esCoreFill',  `esCoreFill_${uid}`],
          ['esAuraGrad',  `esAuraGrad_${uid}`],
          ['esWingGradL', `esWingGradL_${uid}`],
          ['esWingGradR', `esWingGradR_${uid}`],
          ['esCyanGrad',  `esCyanGrad_${uid}`],
          ['esScanClip',  `esScanClip_${uid}`],
        ];

        let html = svgEl.innerHTML;
        idPairs.forEach(([from, to]) => {
          html = html.split(from).join(to);
        });
        svgEl.innerHTML = html;

        /* FF-1 FIX: SVG must NOT have will-change or transform on itself. */
        svgEl.style.willChange = 'auto';
        svgEl.style.transform  = '';
      }

      wrapper.appendChild(clone);
      injected++;
    });

    _invalidateCache();
    console.log(`[ORP_SIGIL] Initialized ${injected} sigil(s).`);
  }


  /* ──────────────────────────────────────────────────────────
     bindSigilHover()
  ─────────────────────────────────────────────────────────── */
  function bindSigilHover() {
    _getSigils().forEach(sigil => {
      if (sigil.classList.contains('entropia-sigil--hero-bg')) return;
      sigil.addEventListener('mouseenter', () => sigil.classList.add('es-hover-active'));
      sigil.addEventListener('mouseleave', () => sigil.classList.remove('es-hover-active'));
    });
  }


  /* ── Utility: HSL → RGB ─────────────────────────────────── */
  function _hslToRgbValues(h, s, l) {
    if (s === 0) {
      const v = Math.round(l * 255);
      return [v, v, v];
    }

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;

    return [
      Math.round(_hue2rgb(p, q, h + 1/3) * 255),
      Math.round(_hue2rgb(p, q, h)       * 255),
      Math.round(_hue2rgb(p, q, h - 1/3) * 255),
    ];
  }

  function _hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  }


  /* ──────────────────────────────────────────────────────────
     initSigilFloat()
     Mouse-tracking LERP float on desktop (≥ 701px).

     MOTION-1: Replaces Lissajous with cursor-following LERP.
     MOTION-2: Motion personality driven by SHS state.
     MOTION-3: Hard viewport-edge clamping — sigil never exits.
     MOTION-4: Default spawn upper-right quadrant.
     MOTION-6: Reads EASE/IDLE_MS/MAX_LEAN from window globals each tick.
     MOTION-7: Warden Unleashed — breaks DOM traps and hunting leash.

     FF-1 FIX: transform applied to .es-float-wrapper div, never the SVG.
     PERF-1: rAF timestamp for all timing; no Date.now() in hot path.
     PERF-2: single style.transform write per tick.
  ─────────────────────────────────────────────────────────── */
  function initSigilFloat() {
    const DESKTOP_BP = 701;
    const EDGE_INSET = 24; /* px buffer from viewport edges */

    /* ── Mouse state ──────────────────────────────────────── */
    let curX = -1;          /* raw cursor X; -1 = no movement yet */
    let curY = -1;
    let lastMoveTs = -Infinity;

    /* ── LERP accumulator ─────────────────────────────────── */
    let leanX = 0;          /* current interpolated offset */
    let leanY = 0;

    /* ── Float pause state ────────────────────────────────── */
    let _rafHandle = null;
    let _paused    = false;
    let _floatEnabled = true;

    /* ── Nav reference ────────────────────────────────────── */
    const _navEl = document.getElementById('main-nav');
    let _navH = _navEl ? _navEl.getBoundingClientRect().height : 0;

    /* ── Geometry cache ───────────────────────────────────── */
    const _geomCache = new WeakMap();

    function _cacheSigilGeometry(sigil) {
      const rect = sigil.getBoundingClientRect();
      _geomCache.set(sigil, {
        halfW: rect.width  / 2,
        halfH: rect.height / 2,
        vw: window.innerWidth,
        vh: window.innerHeight,
      });
    }

    function _cacheAllHeroBg() {
      _getSigils().forEach(s => {
        if (s.classList.contains('entropia-sigil--hero-bg')) {
          _cacheSigilGeometry(s);
        }
      });
    }

    /* ── Mouse tracking ───────────────────────────────────── */
    document.addEventListener('mousemove', e => {
      curX = e.clientX;
      curY = e.clientY;
      lastMoveTs = performance.now();
    }, { passive: true });

    /* ── Visibility pause ─────────────────────────────────── */
    document.addEventListener('visibilitychange', () => {
      _paused = document.hidden;
      if (!_paused && !_rafHandle && _floatEnabled) _schedule();
    });

    function _schedule() {
      _rafHandle = requestAnimationFrame(_tick);
    }

    /* ────────────────────────────────────────────────────────
       _tick(ts)
       Core LERP motion loop.
    ──────────────────────────────────────────────────────── */
    function _tick(ts) {
      _rafHandle = null;

      if (window.innerWidth < DESKTOP_BP || !_floatEnabled) return;

      /* Read current motion params from globals each tick (MOTION-6) */
      const EASE     = Math.max(0.001, Math.min(1, global.SIGIL_EASE    || 0.03));
      const IDLE_MS  = Math.max(100,               global.SIGIL_IDLE_MS || 3000);
      const MAX_LEAN = Math.max(1,                 global.SIGIL_MAX_LEAN || 45);

      const allSigils = _getSigils();
      let hasSigil = false;

      allSigils.forEach(sigil => {
        if (!sigil.classList.contains('entropia-sigil--hero-bg')) return;
        hasSigil = true;

        /* ── Geometry from cache ──────────────────────────── */
        let geom = _geomCache.get(sigil);
        if (!geom) {
          _cacheSigilGeometry(sigil);
          geom = _geomCache.get(sigil);
          if (!geom) { if (!_paused) _schedule(); return; }
        }
        const { halfW, halfH, vw, vh } = geom;

        /* ── MOTION-7: Warden Unleashed Logic ────────────── */
        const idle = curX < 0 || (performance.now() - lastMoveTs) > IDLE_MS;
        const isHunting = MAX_LEAN >= 90; // True for RED and BLACK profiles

        const anchorX = vw  * 0.82;             /* MOTION-4: top-right x */
        const anchorY = _navH + halfH + 12;     /* MOTION-4: just below nav */

        let targetX, targetY;
        
        if (idle && !isHunting) {
          /* Drift back to top-right home when idle (unless hunting) */
          targetX = 0;
          targetY = 0;
        } else if (isHunting) {
          /* Unleash the Warden: Go exactly to the cursor's absolute coordinate */
          targetX = curX - anchorX;
          targetY = curY - anchorY;
        } else {
          /* Standard tethered leaning for GREEN/YELLOW/ORANGE */
          targetX = ((curX / vw)  - 0.5) * 2 * MAX_LEAN;
          targetY = ((curY / vh) - 0.5) * 2 * MAX_LEAN;
        }

        /* ── Dampening: clamp target inside MAX_LEAN radius ─ */
        const dist = Math.sqrt(targetX * targetX + targetY * targetY);
        // MOTION-7: Only enforce the short leash if it is NOT actively hunting
        if (dist > MAX_LEAN && !isHunting) {
          const ratio = MAX_LEAN / dist;
          targetX *= ratio;
          targetY *= ratio;
        }

        /* ── LERP: smooth interpolation toward target ─────── */
        leanX += (targetX - leanX) * EASE;
        leanY += (targetY - leanY) * EASE;

        /* ── Hard viewport-edge clamp (MOTION-3) ─────────── */
        /* Resulting screen position of sigil center */
        const screenX = anchorX + leanX;
        const screenY = anchorY + leanY;

        /* Viewport bounds with edge inset */
        const minScreenX = EDGE_INSET + halfW;
        const maxScreenX = vw  - EDGE_INSET - halfW;
        const minScreenY = _navH + EDGE_INSET + halfH;
        const maxScreenY = vh   - EDGE_INSET - halfH;

        /* Clamp screen position, convert back to lean offset */
        const safeX = Math.min(maxScreenX, Math.max(minScreenX, screenX));
        const safeY = Math.min(maxScreenY, Math.max(minScreenY, screenY));
        const clampedLeanX = safeX - anchorX;
        const clampedLeanY = safeY - anchorY;

   /* ── Subtle tilt mirroring the lean (atmospheric) ── */
// 1. Reduce the multiplier since the travel distance is massive now
let rawTiltX = -clampedLeanY * 0.02; 
let rawTiltY =  clampedLeanX * 0.02;

// 2. Add a hard clamp (e.g., max 5 degrees) so it never flips over
const maxTilt = 5;
const tiltX = Math.max(-maxTilt, Math.min(maxTilt, rawTiltX)).toFixed(2);
const tiltY = Math.max(-maxTilt, Math.min(maxTilt, rawTiltY)).toFixed(2);

        /* ── FF-1 FIX & MOTION-7 DOM ESCAPE ─────────────────
           Lazily create wrapper on first tick if not present.  */
        let wrapper = sigil._esFloatWrapper;
        if (!wrapper) {
          const w = document.createElement('div');
          w.className = 'es-float-wrapper';

          /* MOTION-4: anchor in top-right quadrant (position:fixed) */
          w.style.cssText = [
            'position:fixed',
            `top:${anchorY.toFixed(1)}px`,
            `left:${anchorX.toFixed(1)}px`,
            'margin:0',
            'will-change:transform',    /* FF-1: only on wrapper */
            'pointer-events:none',
            'z-index:9999',             /* MOTION-7: Elevated to float over all content */
            'isolation:auto',           /* FF-2: no stacking context */
          ].join(';');
          
          /* MOTION-7 FIX: Break out of nested DOM traps (like transform on hero containers) */
          document.body.appendChild(w);
          w.appendChild(sigil);
          sigil._esFloatWrapper = w;
          wrapper = w;
        }

        /* PERF-2: single string write */
        wrapper.style.transform =
          `translate(-50%, -50%) translate3d(${clampedLeanX.toFixed(1)}px,${clampedLeanY.toFixed(1)}px,0) rotateX(${tiltX}deg) rotateY(${tiltY}deg)`;
      });

      if (!hasSigil) { if (!_paused) _schedule(); return; }
      if (!_paused && _floatEnabled) _schedule();
    }

    /* ── Float toggle support ─────────────────────────────── */
    global._sigilSetFloat = function(enabled) {
      _floatEnabled = !!enabled;
      if (_floatEnabled && !_rafHandle && !_paused) _schedule();
      if (!_floatEnabled && _rafHandle) {
        cancelAnimationFrame(_rafHandle);
        _rafHandle = null;
      }
    };

    /* ── Resize: debounced geometry refresh ───────────────── */
    let _resizeTimer = null;
    const _resizeObs = new ResizeObserver(() => {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => {
        _navH = _navEl ? _navEl.getBoundingClientRect().height : 0;
        _cacheAllHeroBg();

        const belowBP = window.innerWidth < DESKTOP_BP;
        if (belowBP) {
          _getSigils().forEach(s => {
            if (!s.classList.contains('entropia-sigil--hero-bg')) return;
            const w = s._esFloatWrapper;
            if (w) w.style.transform = '';
          });
          if (_rafHandle) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }
        } else if (!_rafHandle && !_paused && _floatEnabled) {
          _schedule();
        }
      }, 120);
    });
    _resizeObs.observe(document.body);

    /* LOW-1: cleanup on page unload */
    window.addEventListener('pagehide', () => {
      if (_rafHandle) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }
      _resizeObs.disconnect();
      if (_resizeTimer) { clearTimeout(_resizeTimer); _resizeTimer = null; }
    }, { once: true });

    /* Initial geometry + start */
    if (window.innerWidth >= DESKTOP_BP) {
      _cacheAllHeroBg();
      _schedule();
    }
  }


  /* ── Auto-init on DOMContentLoaded ──────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoInit);
  } else {
    _autoInit();
  }

  function _autoInit() {
    initEntropiaSigils();
    bindSigilHover();
    initSigilFloat();

    const firstSigil = _getSigils()[0];
    if (firstSigil) {
      updateSigilDrift(parseFloat(firstSigil.dataset.initialDrift || '0'));
    }

    /* SHS polling — only runs when runtime-overlay.js is absent */
    if (!window._orpRafActive) {
      let _lastSHS = '';

      function _onSHSChange(pill) {
        const shs = pill.textContent.trim().toUpperCase();
        if (shs && shs !== _lastSHS) {
          _lastSHS = shs;
          updateSigilFromSHS(shs === 'AMBER' ? 'YELLOW' : shs);
        }
      }

      function _observeSHSPill(pill) {
        _onSHSChange(pill);
        new MutationObserver(() => _onSHSChange(pill)).observe(pill, {
          childList: true, characterData: true, subtree: true,
        });
      }

      const pill = document.getElementById('cc-tab-shs');
      if (pill) {
        _observeSHSPill(pill);
      } else {
        const _waitObs = new MutationObserver((_, obs) => {
          const p = document.getElementById('cc-tab-shs');
          if (p) { obs.disconnect(); _observeSHSPill(p); }
        });
        _waitObs.observe(document.body, { childList: true, subtree: true });
      }
    }
  }


  /* ── Expose to global scope ──────────────────────────────── */
  global.updateSigilDrift   = updateSigilDrift;
  global.updateSigilFromSHS = updateSigilFromSHS;
  global.initEntropiaSigils = initEntropiaSigils;
  global.initSigilFloat     = initSigilFloat;
  global.setSigilMotion     = setSigilMotion;

}(window));


/* ============================================================
   SHS CLASS-BRIDGE — entropia-sigil.js
   Applies .shs-* classes for CSS-driven state changes.
   Runs after the main IIFE so updateSigilFromSHS is available.
   ============================================================ */
(function () {
  let _lastSHS = '';

  window.updateSigilFromSHS = (function (_original) {
    return function (shs) {
      shs = (shs || 'GREEN').toUpperCase();

      if (shs !== _lastSHS) {
        _lastSHS = shs;

        /* Apply CSS state classes to float wrappers + hero-bg sigils */
        const targets = document.querySelectorAll('.entropia-sigil--hero-bg, .es-float-wrapper');
        targets.forEach(el => {
          el.classList.remove('shs-green', 'shs-yellow', 'shs-orange', 'shs-red', 'shs-black', 'shs-dead');
          if      (shs === 'BLACK' || shs === 'DEAD')  el.classList.add('shs-black');
          else if (shs === 'RED')                       el.classList.add('shs-red');
          else if (shs === 'ORANGE' || shs === 'AMBER') el.classList.add('shs-orange');
          else if (shs === 'YELLOW')                    el.classList.add('shs-yellow');
          else                                          el.classList.add('shs-green');
        });
      }

      /* Delegate to original (sets drift + motion profile) */
      return typeof _original === 'function' ? _original(shs) : undefined;
    };
  }(window.updateSigilFromSHS));

  /* BRIDGE: couple to runtime-overlay.js SHS pill */
  function coupleToOverlay() {
    const pill = window._orpSHSPill || document.getElementById('cc-tab-shs');

    function _onSHSChange() {
      const shs = pill.textContent.trim().toUpperCase();
      window.updateSigilFromSHS(shs === 'AMBER' ? 'YELLOW' : shs);
    }

    if (pill) {
      _onSHSChange();
      new MutationObserver(_onSHSChange).observe(pill, {
        childList: true, characterData: true, subtree: true,
      });
    } else {
      const _waitObs = new MutationObserver((_, obs) => {
        const p = document.getElementById('cc-tab-shs');
        if (p) {
          obs.disconnect();
          window._orpSHSPill = p;
          _onSHSChange();
          new MutationObserver(_onSHSChange).observe(p, {
            childList: true, characterData: true, subtree: true,
          });
        }
      });
      _waitObs.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', coupleToOverlay);
  } else {
    coupleToOverlay();
  }
}());


/* ============================================================
   ORP_SYNC WAKEUP BLOCK — entropia-sigil.js
   Bridges ORP_SYNC.save('sigil_drift', …) and motion params
   to updateSigilDrift() and setSigilMotion() here.
   Also restores EASE/IDLE_MS/MAX_LEAN globals from persistence.

   DEPENDENCY: orp-sync.js must be loaded first in <head>.
   SILENT FAIL: all paths guard against missing ORP_SYNC.
   ============================================================ */
(function () {
  'use strict';

  const SIGIL_SELECTOR = '.entropia-sigil--hero-bg';

  function applyDrift(val) {
    try {
      if (typeof window.updateSigilDrift === 'function') {
        window.updateSigilDrift(val);
      }
    } catch (err) {
      console.warn('ORP_SIGIL_WAKEUP_FAIL: Drift injection blocked.', err);
    }
  }

  function applyMotion(key, val) {
    try {
      if (typeof window.setSigilMotion === 'function') {
        const param = {};
        if (key === 'sigil_ease')     param.ease     = val;
        if (key === 'sigil_idle_ms')  param.idleMs   = val;
        if (key === 'sigil_max_lean') param.maxLean  = val;
        if (key === 'sigil_float')    param.float    = val;
        window.setSigilMotion(param);
      }
    } catch (err) {
      console.warn('ORP_SIGIL_WAKEUP_FAIL: Motion injection blocked.', err);
    }
  }

  function init() {
    const container = document.querySelector(SIGIL_SELECTOR);
    if (!container) return;

    if (typeof window.ORP_SYNC === 'undefined') {
      console.warn('ORP_SIGIL_WAKEUP: ORP_SYNC not found — drift sync disabled.');
      return;
    }

    /* Restore persisted drift */
    const initialDrift = ORP_SYNC.load('sigil_drift', ORP_SYNC.default ? ORP_SYNC.default('sigil_drift') : 0.5);
    applyDrift(initialDrift);

    /* Restore persisted motion params */
    ['sigil_ease', 'sigil_idle_ms', 'sigil_max_lean', 'sigil_float'].forEach(k => {
      const stored = ORP_SYNC.load(k, null);
      if (stored !== null) applyMotion(k, stored);
    });

    /* Subscribe to cross-tab / cross-page sync events */
    window.addEventListener('orp-settings-update', function (e) {
      if (!e.detail) return;
      const { key, value } = e.detail;
      if (key === 'sigil_drift') applyDrift(value);
      if (['sigil_ease','sigil_idle_ms','sigil_max_lean','sigil_float'].includes(key)) {
        applyMotion(key, value);
      }
    });
  }

  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }

}());
