/* ============================================================
   ORP v3.1 | GLOBAL SYNC LAYER  (orp-sync.js)
   ============================================================
   Load via <script src="assets/js/orp-sync.js"></script>
   in the <head> of every page, BEFORE all other scripts.

   PUBLIC API:
     ORP_SYNC.save(key, value)     — persist + broadcast
     ORP_SYNC.load(key, default)   — restore from localStorage
     ORP_SYNC.remove(key)          — delete + broadcast null
     ORP_SYNC.resetAll()           — nuke all orp_* keys to defaults
     ORP_SYNC.snapshot()           — get all current settings
     ORP_SYNC.default(key)         — read canonical default for a key

   EVENT BUS:
     CustomEvent 'orp-settings-update' fires on window for
     every save/remove call so sibling tabs react in real time.
     e.detail = { key: string, value: any }

   MANAGED KEYS:
     Sigil / Visual
       sigil_drift      — 0.0–1.0 drift intensity
       shs_override     — forced SHS state string, or null
       overlay_visible  — NESS HUD shown/hidden

     Motion Parameters (synced to entropia-sigil.js globals)
       sigil_ease       — LERP smoothing factor     (default 0.03)
       sigil_idle_ms    — ms before idle drift-back (default 3000)
       sigil_max_lean   — max px displacement       (default 45)
       sigil_float      — mouse-tracking enabled    (default true)

     NESS / Clinical-Core (bridged from runtime-overlay.js)
       ness_entropy        — cumulative session ΔΣ  (default 0)
       ness_pressure       — SHS state string       (default 'GREEN')
       ness_warden_active  — Warden MANIFEST flag   (default false)

   PATCH LOG:
     v3.1.0 — Added NESS keys (ness_entropy, ness_pressure,
               ness_warden_active) so overlay state survives
               page reloads and propagates cross-tab.
             — Corrected motion defaults to match settings.html
               sliders: ease 0.03, idle_ms 3000, max_lean 45.
               Old values (0.05 / 2000 / 15) caused slider
               mismatch after ORP_SYNC.resetAll().
   ============================================================ */

(function (global) {
  'use strict';

  /* ── Canonical defaults ──────────────────────────────────── */
  const DEFAULTS = {
    // Sigil / visual
    sigil_drift:     0.5,
    shs_override:    null,
    overlay_visible: true,

    // Motion Parameters
    // NOTE: these must match the fallback values used in settings.html
    // (0.03 / 3000 / 45) and in entropia-sigil.js initSigilFloat().
    // The old values (0.05 / 2000 / 15) were stale and caused the
    // settings sliders to reset to wrong positions on ORP_SYNC.resetAll().
    sigil_ease:      0.03,
    sigil_idle_ms:   3000,
    sigil_max_lean:  45,
    sigil_float:     true,

    // NESS / Clinical-Core overlay persistence
    // Bridged into runtime-overlay.js via the ORP_SYNC wakeup block.
    ness_entropy:       0,        // cumulative session ΔΣ (float)
    ness_pressure:      'GREEN',  // SHS state string
    ness_warden_active: false,    // Warden MANIFEST flag
  };

  /* ── Prefix helper ───────────────────────────────────────── */
  const _key = k => `orp_${k}`;

  /* ── Broadcast helper ────────────────────────────────────── */
  function _broadcast(key, value) {
    global.dispatchEvent(new CustomEvent('orp-settings-update', {
      detail: { key, value },
      bubbles: false,
    }));
  }

  global.ORP_SYNC = {
    /**
     * Persist a value and broadcast to all tabs/pages.
     * @param {string} key
     * @param {*}      value  — must be JSON-serializable
     */
    save(key, value) {
      try {
        localStorage.setItem(_key(key), JSON.stringify(value));
      } catch (e) {
        /* Private browsing / storage full — broadcast still fires */
      }
      _broadcast(key, value);
    },

    /**
     * Load a persisted value.
     * @param {string} key
     * @param {*}      defaultValue — returned when absent or unreadable
     * @returns {*}
     */
    load(key, defaultValue) {
      try {
        const raw = localStorage.getItem(_key(key));
        return raw !== null ? JSON.parse(raw) : defaultValue;
      } catch (e) {
        return defaultValue;
      }
    },

    /**
     * Delete a persisted value and broadcast null.
     * @param {string} key
     */
    remove(key) {
      try { localStorage.removeItem(_key(key)); } catch (e) {}
      _broadcast(key, null);
    },

    /**
     * Reset ALL ORP_SYNC keys to canonical defaults.
     * Clears localStorage entries and broadcasts each default.
     */
    resetAll() {
      Object.entries(DEFAULTS).forEach(([k, v]) => {
        try { localStorage.removeItem(_key(k)); } catch (e) {}
        _broadcast(k, v);
      });
    },

    /**
     * Read canonical default for a key.
     * @param {string} key
     * @returns {*}
     */
    default(key) {
      return Object.prototype.hasOwnProperty.call(DEFAULTS, key)
        ? DEFAULTS[key]
        : undefined;
    },

    /**
     * Return a snapshot of all current persisted ORP values.
     * Useful for the settings page state inspector.
     * @returns {Object}
     */
    snapshot() {
      return Object.keys(DEFAULTS).reduce((acc, k) => {
        acc[k] = this.load(k, DEFAULTS[k]);
        return acc;
      }, {});
    },
  };

}(window));