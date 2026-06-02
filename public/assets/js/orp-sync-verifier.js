// orp-sync-verifier.js  v1.1
// ============================================================
// Cross-page sync verification — ensures coordinator state,
// runtime-overlay metrics, and Warden alerts remain consistent
// across all ORP pages via ORP_SYNC and SyncEngine.
//
// LOAD AFTER: orp-sync.js, orp-sync-engine.js, orp-coordinator.js
//
// CHANGES vs v1.0:
//   v1.1  — FIX: SyncVerifier.init() was registering its own
//           orp-settings-update → sessionStorage listener even
//           when SyncEngine was already active. This caused double
//           (or triple with the onmessage path) sessionStorage
//           writes per event. Listener is now only registered when
//           SyncEngine is absent.
//
// PROVIDES:
//   SyncVerifier.audit()         → { valid, issues }
//   SyncVerifier.healMismatch()  → repairs inconsistent state
//   SyncVerifier.exportState()   → snapshot for export
//   SyncVerifier.on('drift', fn) → listen to drift changes
// ============================================================

(function (global) {
  'use strict';

  // ── Critical state keys that must stay in sync ──────────
  var CRITICAL_KEYS = [
    'ness_pressure',        // SHS color state
    'ness_entropy',         // cumulative entropy
    'ness_warden_active',   // Warden blocking state
    'sigil_drift',          // current drift value
    'coordinator_state',    // coordinator mode
    'coordinator_run_id',   // last run id
  ];

  var _listeners = {};

  // ── Internal helpers ────────────────────────────────────

  function _emit(event, data) {
    var fns = _listeners[event] || [];
    fns.forEach(function (fn) {
      try {
        fn(data);
      } catch (e) {
        console.error('[SyncVerifier] Listener error on', event, ':', e);
      }
    });
  }

  function _getORP_SYNC(key, fallback) {
    if (global.ORP_SYNC) {
      return global.ORP_SYNC.load(key, fallback);
    }
    return fallback;
  }

  function _setORP_SYNC(key, value) {
    if (global.ORP_SYNC) {
      global.ORP_SYNC.save(key, value);
    }
  }

  function _getSession(key, fallback) {
    if (global.SyncEngine && global.SyncEngine.session) {
      return global.SyncEngine.session.get(key, fallback);
    }
    return fallback;
  }

  function _setSession(key, value) {
    if (global.SyncEngine && global.SyncEngine.session) {
      global.SyncEngine.session.set(key, value);
    }
  }

  // ═════════════════════════════════════════════════════════
  // PUBLIC API
  // ═════════════════════════════════════════════════════════

  global.SyncVerifier = {
    /**
     * Audit all critical state keys for consistency.
     * @returns { valid: bool, issues: Array<{key, persisted, session, match}> }
     */
    audit: function () {
      var issues = [];

      for (var i = 0; i < CRITICAL_KEYS.length; i++) {
        var key = CRITICAL_KEYS[i];
        var persisted = _getORP_SYNC(key, undefined);
        var session = _getSession(key, undefined);

        var match = JSON.stringify(persisted) === JSON.stringify(session);

        if (!match) {
          issues.push({
            key: key,
            persisted: persisted,
            session: session,
            match: false,
          });
        }
      }

      var result = {
        valid: issues.length === 0,
        checked: CRITICAL_KEYS.length,
        issues: issues,
        timestamp: new Date().toISOString(),
      };

      if (issues.length > 0) {
        console.warn('[SyncVerifier] Audit found', issues.length, 'inconsistenc(ies):', result);
        _emit('audit-failed', result);
      } else {
        console.log('[SyncVerifier] Audit passed — all', CRITICAL_KEYS.length, 'keys consistent');
        _emit('audit-passed', result);
      }

      return result;
    },

    /**
     * Heal a specific mismatch by favoring persisted (ORP_SYNC) state.
     * This is the "source of truth" during sync conflicts.
     *
     * @param {string} key  — the key to heal
     * @returns { healed: bool, key, from, to }
     */
    healMismatch: function (key) {
      var persisted = _getORP_SYNC(key, undefined);
      var session = _getSession(key, undefined);

      if (JSON.stringify(persisted) === JSON.stringify(session)) {
        return { healed: false, reason: 'Already in sync', key: key };
      }

      // Favor persisted state (ORP_SYNC) — push to session
      _setSession(key, persisted);

      console.log('[SyncVerifier] Healed', key, ': session ←', persisted);

      _emit('healed', {
        key: key,
        from: session,
        to: persisted,
      });

      return {
        healed: true,
        key: key,
        from: session,
        to: persisted,
      };
    },

    /**
     * Force full re-heal of all mismatches (persisted → session).
     * Use after page navigation or major state changes.
     *
     * @returns { healed: number, issues: Array }
     */
    healAll: function () {
      var audit = this.audit();
      var healed = 0;

      for (var i = 0; i < audit.issues.length; i++) {
        var issue = audit.issues[i];
        var result = this.healMismatch(issue.key);
        if (result.healed) healed++;
      }

      console.log('[SyncVerifier] healed', healed, '/', audit.issues.length, 'mismatches');

      _emit('healed-all', {
        healed: healed,
        total: audit.issues.length,
      });

      return {
        healed: healed,
        issues: audit.issues,
      };
    },

    /**
     * Export complete snapshot of all ORP_SYNC keys + session state
     * for debugging or inter-page transfer.
     *
     * @returns { sync: Object, session: Object, mismatch: bool }
     */
    exportState: function () {
      var sync = global.ORP_SYNC ? global.ORP_SYNC.snapshot() : {};
      var session = {};

      var allKeys = Object.keys(sync);
      for (var i = 0; i < allKeys.length; i++) {
        session[allKeys[i]] = _getSession(allKeys[i], undefined);
      }

      var syncStr = JSON.stringify(sync);
      var sessionStr = JSON.stringify(session);
      var mismatch = syncStr !== sessionStr;

      return {
        page: (function () {
          var match = window.location.href.match(/\/([^\/?\#]+)\.html/);
          return match ? match[1] : 'unknown';
        })(),
        sync: sync,
        session: session,
        mismatch: mismatch,
        timestamp: new Date().toISOString(),
      };
    },

    /**
     * Monitor a specific key for changes.
     * Fires callback whenever it changes in either ORP_SYNC or session.
     *
     * @param {string} key
     * @param {Function} callback
     * @returns { stop: Function } — call to unsubscribe
     */
    watchKey: function (key, callback) {
      var lastValue = _getORP_SYNC(key);
      var self = this;

      var interval = setInterval(function () {
        var current = _getORP_SYNC(key);
        if (JSON.stringify(lastValue) !== JSON.stringify(current)) {
          lastValue = current;
          callback({
            key: key,
            value: current,
            timestamp: new Date().toISOString(),
          });
        }
      }, 200);

      return {
        stop: function () {
          clearInterval(interval);
        },
      };
    },

    /**
     * Register an event listener for verification events:
     *   - 'audit-passed'   → all keys consistent
     *   - 'audit-failed'   → mismatches detected
     *   - 'healed'         → single mismatch repaired
     *   - 'healed-all'     → batch heal completed
     *
     * @param {string} event
     * @param {Function} fn
     */
    on: function (event, fn) {
      if (!_listeners[event]) _listeners[event] = [];
      _listeners[event].push(fn);
    },

    /**
     * Continuous verification mode — audits every N ms.
     * Useful for catching drift during heavy coordinator activity.
     *
     * @param {number} intervalMs (default 1000)
     * @returns { stop: Function }
     */
    startContinuousAudit: function (intervalMs) {
      if (intervalMs === undefined) intervalMs = 1000;

      var lastIssueCount = 0;
      var interval = setInterval(function () {
        var audit = global.SyncVerifier.audit();
        if (audit.issues.length !== lastIssueCount) {
          lastIssueCount = audit.issues.length;
          if (audit.issues.length > 0) {
            console.warn('[SyncVerifier] Continuous audit found drift');
            _emit('drift', audit);
          }
        }
      }, intervalMs);

      console.log('[SyncVerifier] Continuous audit started —', intervalMs, 'ms interval');

      return {
        stop: function () {
          clearInterval(interval);
          console.log('[SyncVerifier] Continuous audit stopped');
        },
      };
    },

    /**
     * Get summary of current state health.
     */
    getHealth: function () {
      var audit = this.audit();
      var exported = this.exportState();

      return {
        page: exported.page,
        syncHealthy: audit.valid,
        issueCount: audit.issues.length,
        hasSyncEngine: !!global.SyncEngine,
        hasCoordinator: !!global.ORP_COORDINATOR,
        hasWarden: !!global.Warden,
        timestamp: new Date().toISOString(),
      };
    },

    /**
     * Initialize verification subsystem.
     * Optional: start continuous audit.
     *
     * @param {Object} opts — { continuous: bool, intervalMs: number }
     */
    init: function (opts) {
      opts = opts || {};

      console.log('[SyncVerifier] Initializing...');

      // Mirror ORP_SYNC updates to sessionStorage ONLY when SyncEngine
      // is not active. When SyncEngine.init() has already run, it owns
      // the orp-settings-update → sessionStorage mirror. Adding a second
      // listener here would cause double (or triple) writes per event.
      // FIX: guard so this listener is registered only when SyncEngine
      // is absent.
      if (!global.SyncEngine || typeof global.SyncEngine.init !== 'function') {
        global.addEventListener('orp-settings-update', function (e) {
          if (!e || !e.detail) return;
          _setSession(e.detail.key, e.detail.value);
        });
      }

      // Optional: start continuous audit
      if (opts.continuous) {
        this.startContinuousAudit(opts.intervalMs || 1000);
      }

      console.log('[SyncVerifier] Ready');
    },
  };
}(window));
