/* ============================================================
   ENTROPIA SIGIL — JavaScript Module
   ORP Δ v3.0 | entropia-sigil.js

   DROP-IN: Add <script src="assets/js/entropia-sigil.js"></script>
   to your page's <body> end, AFTER main.js and runtime-overlay.js.

   PUBLIC API:
     updateSigilDrift(0.0–1.0)   — set by numeric drift score
     updateSigilFromSHS('GREEN')  — set by SHS state string
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

  /* ── Memoization state ────────────────────────────────────── */
  let _lastIntensity  = -1; // sentinel; ensures first call always writes
  let _lastSigilCount = 0;
  let _lastGlowDrift  = -1;
  let _lastGlowValue  = '';

  /* ── Cached sigil NodeList ────────────────────────────────────
     querySelectorAll is called once after init and re-used.
     Re-queried only when initEntropiaSigils() stamps new sigils.
  ─────────────────────────────────────────────────────────── */
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
     Clamps input to [0, 1].
  ─────────────────────────────────────────────────────────── */
  function updateSigilDrift(driftValue) {
    const intensity = Math.min(Math.max(parseFloat(driftValue) || 0, 0), 1);
    const sigils    = _getSigils();

    // Skip DOM writes when neither the value nor the sigil set has changed
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
     Maps: 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'BLACK'
  ─────────────────────────────────────────────────────────── */
  function updateSigilFromSHS(shsState) {
    const key       = (shsState || 'GREEN').trim().toUpperCase();
    const intensity = SHS_DRIFT_MAP[key] ?? 0;
    return updateSigilDrift(intensity);
  }


  /* ── Internal: compute SHS-aware glow colour ─────────────── */
  function _driftToGlow(intensity) {
    // Round to 3 dp to absorb float noise; skip rebuild when value unchanged
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
     De-duplicates SVG filter IDs for multi-sigil pages.
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
      }

      wrapper.appendChild(clone);
      injected++;
    });

    // Sigil DOM changed — invalidate cache so _getSigils() re-scans
    _invalidateCache();
    console.log(`[ORP_SIGIL] Initialized ${injected} sigil(s).`);
  }


  /* ──────────────────────────────────────────────────────────
     bindSigilHover()
     Adds 'es-hover-active' class on mouse enter/leave.
     CSS handles the visual response — no JS animation needed.
  ─────────────────────────────────────────────────────────── */
  function bindSigilHover() {
    _getSigils().forEach(sigil => {
      if (sigil.classList.contains('entropia-sigil--hero-bg')) return;
      sigil.addEventListener('mouseenter', () => sigil.classList.add('es-hover-active'));
      sigil.addEventListener('mouseleave', () => sigil.classList.remove('es-hover-active'));
    });
  }


  /* ── Utility: HSL → RGB ─────────────────────────────────── */
  /* Allocation-free version: returns three separate integers
     instead of creating a new array on every drift update.    */
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
     Boundary-aware Lissajous float on desktop (≥ 701px).
     Pauses when tab is backgrounded. Stops on mobile.

     DRIFT COUPLING: amplitude and speed scale with drift so
     the sigil floats more erratically at high entropy.
  ─────────────────────────────────────────────────────────── */
  function initSigilFloat() {
    const DESKTOP_BP  = 701;
    const EDGE_INSET  = 16;
    const BASE_AMP_X  = 38;
    const BASE_AMP_Y  = 52;
    const PERIOD_X    = 28000;
    const PERIOD_Y    = 22000;

    let _rafHandle = null;
    let _paused    = false;

    // Cache the nav element lookup — it never changes
    const _navEl = document.getElementById('main-nav');

    // Cache nav height — stable between resizes; avoids getBoundingClientRect per frame
    let _navH = _navEl ? _navEl.getBoundingClientRect().height : 0;

    document.addEventListener('visibilitychange', () => {
      _paused = document.hidden;
      if (!_paused && !_rafHandle) _schedule();
    });

    function _schedule() {
      _rafHandle = requestAnimationFrame(_tick);
    }

    function _tick(ts) {
      _rafHandle = null;

      if (window.innerWidth < DESKTOP_BP) return;

      // Use cached NodeList from _getSigils() — no querySelectorAll per frame
      const allSigils = _getSigils();

      // Filter to hero-bg sigils without allocating a new array when possible
      let hasSigil = false;
      allSigils.forEach(sigil => {
        if (!sigil.classList.contains('entropia-sigil--hero-bg')) return;
        hasSigil = true;

        const drift  = parseFloat(sigil.style.getPropertyValue('--drift-intensity') || '0');
        const ampX   = BASE_AMP_X * (1 + drift * 0.30);
        const ampY   = BASE_AMP_Y * (1 + drift * 0.30);
        const spdMul = 1 + drift * 0.40;

        const tx = Math.sin((ts * spdMul) / PERIOD_X * Math.PI * 2) * ampX;
        const ty = Math.sin((ts * spdMul) / PERIOD_Y * Math.PI * 2 + 0.9) * ampY;

        const rect  = sigil.getBoundingClientRect();
        const halfW = rect.width  / 2;
        const halfH = rect.height / 2;
        const cx    = rect.left + halfW;
        const cy    = rect.top  + halfH;

        const clampedTx = Math.min(window.innerWidth  - EDGE_INSET - halfW - cx,
                           Math.max(EDGE_INSET + halfW - cx, tx));
        const clampedTy = Math.min(window.innerHeight - EDGE_INSET - halfH - cy,
                           Math.max(_navH + EDGE_INSET + halfH - cy, ty));

        sigil.style.transform =
          `translateY(-50%) translate3d(${clampedTx.toFixed(2)}px,${clampedTy.toFixed(2)}px,0)`;
      });

      if (!hasSigil) return _schedule(); // keep looping even if no hero-bg sigil yet

      if (!_paused) _schedule();
    }

    let _resizeTimer = null;
    const _resizeObs = new ResizeObserver(() => {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => {
        _navH = _navEl ? _navEl.getBoundingClientRect().height : 0; // refresh cached nav height
        if (window.innerWidth < DESKTOP_BP) {
          _getSigils().forEach(s => {
            if (s.classList.contains('entropia-sigil--hero-bg')) s.style.transform = '';
          });
          if (_rafHandle) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }
        } else if (!_rafHandle && !_paused) {
          _schedule();
        }
      }, 120);
    });
    _resizeObs.observe(document.body);

    if (window.innerWidth >= DESKTOP_BP) _schedule();
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

    /* SHS polling — only runs when runtime-overlay.js is absent.
       Uses MutationObserver (fires only on DOM change) instead of
       setInterval, eliminating 800ms periodic wakeups entirely.
       Falls back gracefully if the pill doesn't exist yet. */
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
        _onSHSChange(pill); // sync immediately on attach
        new MutationObserver(() => _onSHSChange(pill)).observe(pill, {
          childList: true, characterData: true, subtree: true,
        });
      }

      const pill = document.getElementById('cc-tab-shs');
      if (pill) {
        _observeSHSPill(pill);
      } else {
        // Pill not yet inserted — watch document.body for its arrival
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

}(window));
