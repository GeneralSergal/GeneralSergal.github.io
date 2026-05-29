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
    'GREEN':  0.00,   // Nominal — idle breath only
    'YELLOW': 0.25,   // Watch   — slight fracture appearance
    'ORANGE': 0.55,   // Elevated — visible shards + jitter begins
    'RED':    0.78,   // Critical — aggressive glitch + scan bleed
    'BLACK':  1.00,   // Fracture — full entropic collapse
  };


  /* ──────────────────────────────────────────────────────────
     updateSigilDrift(driftValue)
     ─────────────────────────────
     The primary telemetry bridge function.
     Sets --drift-intensity on every .entropia-sigil element
     on the page. Clamps input to [0, 1].

     USAGE:
       updateSigilDrift(0.0);   // stable
       updateSigilDrift(0.55);  // elevated drift
       updateSigilDrift(1.0);   // full fracture

     WIRE INTO YOUR TELEMETRY:
       Call this wherever your runtime-overlay.js or main.js
       reads/updates DRIFT or SHS metrics. Example:

         // Inside your telemetry refresh loop:
         updateSigilDrift(parseFloat(driftMetric));
  ─────────────────────────────────────────────────────────── */
  function updateSigilDrift(driftValue) {
    const intensity = Math.min(Math.max(parseFloat(driftValue) || 0, 0), 1);

    const sigils = document.querySelectorAll('.entropia-sigil');
    sigils.forEach(sigil => {
      sigil.style.setProperty('--drift-intensity', intensity);
      sigil.style.setProperty('--es-shs-glow', _driftToGlow(intensity));
    });

    console.log(
      `[ORP_TELEMETRY] Sigil drift intensity set to: ${(intensity * 100).toFixed(2)}%`
    );

    return intensity;
  }


  /* ──────────────────────────────────────────────────────────
     updateSigilFromSHS(shsState)
     ─────────────────────────────
     Convenience wrapper — pass SHS string directly.
     Maps: 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'BLACK'

     USAGE:
       updateSigilFromSHS('RED');

     WIRE INTO YOUR TELEMETRY:
       Wherever you set SHS state (e.g. on a dashboard metric
       card or runtime warden), also call:
         updateSigilFromSHS(newShsState);
  ─────────────────────────────────────────────────────────── */
  function updateSigilFromSHS(shsState) {
    const key       = (shsState || 'GREEN').trim().toUpperCase();
    const intensity = SHS_DRIFT_MAP[key] ?? 0;
    return updateSigilDrift(intensity);
  }


  /* ── Internal: compute SHS-aware glow colour ─────────────── */
  function _driftToGlow(intensity) {
    // Cross-fade: green (stable) → red (fractured)
    const hue = 120 - intensity * 120;
    const [r, g, b] = _hslToRgb(hue / 360, 0.85, 0.5);
    const alpha = 0.15 + intensity * 0.30;
    return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
  }


  /* ──────────────────────────────────────────────────────────
     initEntropiaSigils()
     ─────────────────────
     Stamps the SVG from <template id="entropiaSigilTemplate">
     into every empty .entropia-sigil wrapper.
     Automatically de-duplicates SVG filter IDs so multiple
     sigils on one page don't share/conflict filters.

     Call once on DOMContentLoaded (done automatically below).
  ─────────────────────────────────────────────────────────── */
  function initEntropiaSigils() {
    const template = document.getElementById('entropiaSigilTemplate');

    if (!template) {
      console.warn('[ORP_SIGIL] <template id="entropiaSigilTemplate"> not found. ' +
                   'Sigils must be pre-rendered in HTML or template must be added.');
      return;
    }

    let injected = 0;

    document.querySelectorAll('.entropia-sigil').forEach(wrapper => {
      // Skip wrappers that already contain an SVG
      if (wrapper.querySelector('svg')) return;

      const clone = template.content.cloneNode(true);
      const uid   = Math.random().toString(36).slice(2, 7);
      const svgEl = clone.querySelector('svg');

      if (svgEl) {
        // Rewrite all filter/gradient/clip IDs to be unique
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

    console.log(`[ORP_SIGIL] Initialized ${injected} sigil(s).`);
  }


  /* ──────────────────────────────────────────────────────────
     bindSigilHover()
     ─────────────────
     Adds 'es-hover-active' class on mouse enter/leave.
     CSS handles the visual response — no JS animation needed.
     Called automatically on init.
  ─────────────────────────────────────────────────────────── */
  function bindSigilHover() {
    document.querySelectorAll('.entropia-sigil').forEach(sigil => {
      // Never bind hover on background/decorative sigils
      if (sigil.classList.contains('entropia-sigil--hero-bg')) return;
      sigil.addEventListener('mouseenter', () => sigil.classList.add('es-hover-active'));
      sigil.addEventListener('mouseleave', () => sigil.classList.remove('es-hover-active'));
    });
  }


  /* ── Utility: HSL → RGB ─────────────────────────────────── */
  function _hslToRgb(h, s, l) {
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
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

    // Read initial drift from a data attribute if present:
    //   <div class="entropia-sigil" data-initial-drift="0.25">
    const firstSigil = document.querySelector('.entropia-sigil');
    if (firstSigil) {
      const initial = parseFloat(firstSigil.dataset.initialDrift || '0');
      updateSigilDrift(initial);
    }
  }


  /* ── Expose to global scope ──────────────────────────────── */
  global.updateSigilDrift    = updateSigilDrift;
  global.updateSigilFromSHS  = updateSigilFromSHS;
  global.initEntropiaSigils  = initEntropiaSigils;

}(window));
