// orp-sync-engine.js  v2.2
// ============================================================
// Mirrors ORP_SYNC state into sessionStorage and synchronises
// across tabs via BroadcastChannel.
//
// CHANGES vs v2.1:
//   v2.2  — BUG FIXES:
//     FIX-1  init() was never auto-called — sessionStorage never
//            seeded on 7/8 pages (only coordinator.html called
//            PageBootstrap.init() which calls SyncEngine.init()).
//            Auto-init now runs synchronously at module load.
//            ORP_SYNC is guaranteed present (orp-sync.js always
//            loads first per documented load order).
//     FIX-2  Double sessionStorage write in onmessage: the direct
//            _writeSession() call was redundant because
//            ORP_SYNC.save() fires orp-settings-update which
//            the step-2 listener already handles. Removed the
//            direct call.
//     FIX-3  BroadcastChannel.onmessage was set inside init() —
//            any cross-tab messages arriving before init() ran
//            (coordinator.html inline script race window) were
//            silently dropped. Handler now set at module load,
//            before init() call.
//     FIX-4  No idempotency guard — if init() was called more
//            than once (e.g. PageBootstrap.init() after auto-
//            init), orp-settings-update and storage listeners
//            stacked, causing triple/quadruple sessionStorage
//            writes per event. Guard added.
//
// DEPENDS ON: orp-sync.js loaded first (window.ORP_SYNC must exist).
//
// LOAD ORDER:
//   <script src="assets/js/orp-sync.js"></script>        ← first (head)
//   <script src="assets/js/orp-sync-engine.js"></script> ← any time after
//
// USAGE:
//   SyncEngine is auto-initialised at load.
//   SyncEngine.emit('sigil_drift', 0.7);   // persist + broadcast
//   SyncEngine.session.get('sigil_drift'); // read session state
// ============================================================

(function (global) {
  'use strict';

  var ORP_CHANNEL  = new BroadcastChannel('orp_sync_bus');
  var _initialized = false;

  // ── Internal helpers ────────────────────────────────────────

  /** Prefixed key used in both localStorage and sessionStorage. */
  function _sKey(key) { return 'orp_' + key; }

  /** Write one key/value into sessionStorage (JSON-serialised). */
  function _writeSession(key, value) {
    try {
      if (value === null || value === undefined) {
        sessionStorage.removeItem(_sKey(key));
      } else {
        sessionStorage.setItem(_sKey(key), JSON.stringify(value));
      }
    } catch (e) {
      // sessionStorage unavailable (private browsing edge-case) — silent.
    }
  }

  /** Read one value back out of sessionStorage. */
  function _readSession(key, defaultValue) {
    try {
      var raw = sessionStorage.getItem(_sKey(key));
      return raw !== null ? JSON.parse(raw) : defaultValue;
    } catch (e) {
      return defaultValue;
    }
  }

  // ── Cross-tab message handler — set at module load (FIX-3) ──
  // Setting this here (outside init()) ensures no messages are
  // dropped during the window between script execution and the
  // init() call. ORP_SYNC.save() is the single authority for
  // localStorage writes and fires the local orp-settings-update
  // event; the step-2 listener in init() then mirrors to session.
  // FIX-2: removed the redundant direct _writeSession() call that
  // was here — the orp-settings-update listener handles it once.
  ORP_CHANNEL.onmessage = function (event) {
    if (!event || !event.data || event.data.type !== 'SYNC') return;
    var key   = event.data.key;
    var value = event.data.value;

    // Push through ORP_SYNC so localStorage and the local event bus
    // stay consistent. The orp-settings-update listener (registered
    // in init()) mirrors the value to sessionStorage — no direct
    // _writeSession() call needed here (FIX-2).
    // If init() has not yet run, write directly as a fallback so no
    // cross-tab value is lost during startup.
    if (!_initialized) {
      _writeSession(key, value);
    }
    if (global.ORP_SYNC) {
      global.ORP_SYNC.save(key, value);
    }
  };

  // ── Public API ───────────────────────────────────────────────

  global.SyncEngine = {

    /**
     * Broadcast a state change to all other tabs/windows AND
     * persist it through ORP_SYNC (localStorage + event bus).
     * sessionStorage is updated automatically via the
     * 'orp-settings-update' listener set up in init().
     *
     * @param {string} key   — ORP_SYNC key (no orp_ prefix needed)
     * @param {*}      value — must be JSON-serialisable
     */
    emit: function (key, value) {
      // Let ORP_SYNC own persistence + local event dispatch.
      if (global.ORP_SYNC) {
        global.ORP_SYNC.save(key, value);
      }
      // Also broadcast to other tabs so they don't have to wait
      // for the 'storage' event round-trip.
      ORP_CHANNEL.postMessage({ type: 'SYNC', key: key, value: value });
    },

    /**
     * Initialise cross-tab reactivity and seed sessionStorage.
     * Idempotent — safe to call multiple times (FIX-4).
     * Auto-called at module load; explicit call from PageBootstrap
     * is a no-op on the second invocation.
     */
    init: function () {
      if (_initialized) return;   // FIX-4: idempotency guard
      _initialized = true;

      // ── 1. Seed sessionStorage from current ORP_SYNC snapshot ──
      if (global.ORP_SYNC) {
        var snapshot = global.ORP_SYNC.snapshot();
        var keys = Object.keys(snapshot);
        for (var i = 0; i < keys.length; i++) {
          _writeSession(keys[i], snapshot[keys[i]]);
        }
      }

      // ── 2. Mirror every ORP_SYNC save/remove into sessionStorage ──
      global.addEventListener('orp-settings-update', function (e) {
        if (!e || !e.detail) return;
        _writeSession(e.detail.key, e.detail.value);
      });

      // ── 3. Keep sessionStorage in sync with direct localStorage ──
      // Catches any external writes that bypass ORP_SYNC entirely.
      global.addEventListener('storage', function (e) {
        if (!e.key || e.key.indexOf('orp_') !== 0) return;
        var bareKey = e.key.slice(4); // strip 'orp_' prefix
        try {
          var value = e.newValue !== null ? JSON.parse(e.newValue) : null;
          _writeSession(bareKey, value);
        } catch (_) {
          // Malformed value in localStorage — skip.
        }
      });
    },

    /**
     * Low-level sessionStorage accessors for modules that need to
     * read session state without going through ORP_SYNC.
     */
    session: {
      /**
       * Read a value from sessionStorage.
       * Falls back to ORP_SYNC.default() when the key is absent.
       *
       * @param {string} key
       * @param {*}      [fallback]
       * @returns {*}
       */
      get: function (key, fallback) {
        var def = (fallback !== undefined)
          ? fallback
          : (global.ORP_SYNC ? global.ORP_SYNC.default(key) : undefined);
        return _readSession(key, def);
      },

      /**
       * Write directly to sessionStorage.
       * Does NOT persist to localStorage or broadcast.
       * Use SyncEngine.emit() for full cross-tab persistence.
       *
       * @param {string} key
       * @param {*}      value
       */
      set: function (key, value) {
        _writeSession(key, value);
      },

      /**
       * Remove a key from sessionStorage only.
       *
       * @param {string} key
       */
      clear: function (key) {
        _writeSession(key, null);
      },
    },
  };

  // ── FIX-1: Auto-initialise at module load ────────────────────
  // ORP_SYNC is guaranteed present (orp-sync.js always loads first).
  // init() touches only storage APIs — safe before DOMContentLoaded.
  global.SyncEngine.init();

}(window));
