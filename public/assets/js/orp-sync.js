/* ============================================================
   ORP v3.0 | GLOBAL SYNC LAYER  (orp-sync.js)
   ============================================================
   Load via <script src="assets/js/orp-sync.js"></script>
   in the <head> of every page, BEFORE all other scripts.

   PUBLIC API:
     ORP_SYNC.save(key, value)     — persist + broadcast
     ORP_SYNC.load(key, default)   — restore from localStorage
     ORP_SYNC.remove(key)          — delete + broadcast null
     ORP_SYNC.resetAll()           — nuke all orp_* keys to defaults
     ORP_SYNC.snapshot()           — get all current settings

   EVENT BUS:
     CustomEvent 'orp-settings-update' fires on window for
     every save/remove call so sibling tabs react in real time.
     e.detail = { key: string, value: any }
   ============================================================ */

(function (global) {
  'use strict';

  /* ── Canonical defaults ──────────────────────────────────── */
  const DEFAULTS = {
    sigil_drift:     0.5,
    shs_override:    null,
    overlay_visible: true,
    // Motion Parameters
    sigil_ease:      0.05,
    sigil_idle_ms:   2000,
    sigil_max_lean:  15,
    sigil_float:     true
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