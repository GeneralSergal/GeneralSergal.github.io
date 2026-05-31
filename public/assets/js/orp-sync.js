/* ============================================================
   ORP v3.2 | GLOBAL SYNC LAYER  (orp-sync.js)
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
     ORP_SYNC.applyAll()           — fire all current values as
                                     orp-settings-update events so
                                     late-loading modules can hydrate

   EVENT BUS:
     CustomEvent 'orp-settings-update' fires on window for
     every save/remove call so sibling tabs react in real time.
     e.detail = { key: string, value: any }

   MANAGED KEYS — Sigil / Visual:
     sigil_drift        — 0.0–1.0 drift intensity
     shs_override       — forced SHS state string, or null
     overlay_visible    — NESS HUD shown/hidden

   MANAGED KEYS — Motion Parameters:
     sigil_ease         — LERP smoothing factor     (default 0.03)
     sigil_idle_ms      — ms before idle drift-back (default 3000)
     sigil_max_lean     — max px displacement       (default 45)
     sigil_float        — mouse-tracking enabled    (default true)

   MANAGED KEYS — NESS / Clinical-Core:
     ness_entropy       — cumulative session ΔΣ     (default 0)
     ness_pressure      — SHS state string          (default 'GREEN')
     ness_warden_active — Warden MANIFEST flag      (default false)

   MANAGED KEYS — Visual Environment:
     env_glyph_opacity  — glyph-layer CSS opacity   (default 0.05)
     env_grid_opacity   — grid-bg CSS opacity scale (default 1.0)
     env_ember_count    — active ember count 0–5    (default 5)
     env_glow_scale     — sigil glow multiplier     (default 1.0)
     env_perf_mode      — reduce non-essential anim (default false)

   MANAGED KEYS — UI Preferences:
     ui_overlay_side    — 'left' | 'right'          (default 'left')
     ui_log_limit       — max log entries 10–200    (default 60)
     ui_ascii_panel     — show ASCII art panel      (default true)
     ui_shs_speed       — SHS transition speed ms   (default 300)
     ui_reduced_motion  — mirrors prefers-reduced-motion pref
                          (default false, honoured on top of OS)

   PATCH LOG:
     v3.1.0 — Added NESS keys; corrected motion defaults.
     v3.2.0 — Made ORP_SYNC the sole settings authority:
               • Added env_* visual environment keys.
               • Added ui_* UI preference keys.
               • Added ORP_SYNC.applyAll() for late-boot hydration.
               • Tightened _broadcast to always serialise null
                 as null (not undefined) for consistent consumer
                 checks.
               • ORP_SYNC is now the only place defaults live —
                 consumers must call ORP_SYNC.load(k, ORP_SYNC.default(k))
                 instead of hard-coding fallback values.
   ============================================================ */

(function (global) {
  'use strict';

  /* ── Canonical defaults ───────────────────────────────────
     This object is the single source of truth for every
     setting default across the entire ORP system.
     Consumers MUST derive their fallback from ORP_SYNC.default()
     rather than hard-coding values locally.
  ─────────────────────────────────────────────────────────── */
  const DEFAULTS = {
    /* ── Sigil / visual ─────────────────────────────────── */
    sigil_drift:     0.5,
    shs_override:    null,
    overlay_visible: true,

    /* ── Motion Parameters ──────────────────────────────── */
    // NOTE: match the SHS_MOTION_MAP "steady" profile in entropia-sigil.js
    // and the slider initial values in settings.html.
    // Old stale values (0.05 / 2000 / 15) caused slider mismatch on resetAll().
    sigil_ease:      0.03,
    sigil_idle_ms:   3000,
    sigil_max_lean:  45,
    sigil_float:     true,

    /* ── NESS / Clinical-Core ───────────────────────────── */
    ness_entropy:       0,
    ness_pressure:      'GREEN',
    ness_warden_active: false,

    /* ── Visual Environment ─────────────────────────────── */
    // env_glyph_opacity: CSS opacity on .glyph-layer (0–1)
    env_glyph_opacity:  0.05,
    // env_grid_opacity: multiplier on grid-bg alpha (0.2–2.0; 1.0 = nominal)
    env_grid_opacity:   1.0,
    // env_ember_count: how many .ember-N divs are visible (0–5)
    env_ember_count:    5,
    // env_glow_scale: multiplier for --glow-core / --glow-outer sigil CSS vars
    env_glow_scale:     1.0,
    // env_perf_mode: suppress non-essential animations (resonance ring, glyphs)
    env_perf_mode:      false,

    /* ── UI Preferences ─────────────────────────────────── */
    // ui_overlay_side: 'left' | 'right' — which side the NESS HUD docks to
    ui_overlay_side:   'left',
    // ui_log_limit: max log lines in #cc-log (10–200)
    ui_log_limit:       60,
    // ui_ascii_panel: whether .ascii-core-panel receives live updates
    ui_ascii_panel:     true,
    // ui_shs_speed: transition-duration ms for SHS pill / metric colour changes
    ui_shs_speed:       300,
    // ui_reduced_motion: user-side motion kill-switch (layers on top of OS pref)
    ui_reduced_motion:  false,
  };

  /* ── Prefix helper ───────────────────────────────────────── */
  const _key = k => `orp_${k}`;

  /* ── Broadcast helper ────────────────────────────────────── */
  function _broadcast(key, value) {
    // value may be null (remove) — always pass it explicitly so
    // consumers can distinguish null from undefined
    global.dispatchEvent(new CustomEvent('orp-settings-update', {
      detail: { key, value: value !== undefined ? value : null },
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
     * Consumers MUST use this instead of local hard-coded fallbacks
     * so that a single change here propagates everywhere.
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
     * Keys with no localStorage entry return their canonical default.
     * @returns {Object}
     */
    snapshot() {
      return Object.keys(DEFAULTS).reduce((acc, k) => {
        acc[k] = this.load(k, DEFAULTS[k]);
        return acc;
      }, {});
    },

    /**
     * Fire orp-settings-update for every key with its current value.
     * Call this after a module boots late so it can hydrate from
     * the current persisted state without needing a page reload.
     * Each event is dispatched synchronously.
     */
    applyAll() {
      Object.keys(DEFAULTS).forEach(k => {
        _broadcast(k, this.load(k, DEFAULTS[k]));
      });
    },
  };

}(window));
