// orp-page-bootstrap.js  v1.1
// ============================================================
// Unified bootstrap for all ORP pages — ensures consistent
// sync engine init, Warden integration, coordinator awareness,
// and runtime-overlay readiness across all pages.
//
// CHANGES vs v1.0:
//   v1.1  — FIX: PageBootstrap.init() was only called on
//           coordinator.html via an explicit inline <script>.
//           All other pages loaded this file but never called
//           init(), leaving SyncEngine unseeded on those pages
//           (redundant with the FIX-1 auto-init in
//           orp-sync-engine.js v2.2) and Warden/Coordinator
//           hooks silent. Auto-init now runs at end of file.
//
// LOAD ORDER:
//   1. orp-sync.js                (in <head>)
//   2. main.js (+ entropia-sigil + runtime-overlay)
//   3. registry.js (if applicable)
//   4. orp-coordinator.js (if applicable)
//   5. orp-page-bootstrap.js      (this file, at end of <body>)
//
// This file does NOT load those scripts — it just initializes
// them if they exist, and sets up cross-page verification.
// ============================================================

(function (global) {
  'use strict';

  var PageBootstrap = {
    /**
     * Core initialization — call once per page.
     * Safe no-op if any dependency is missing.
     */
    init: function () {
      // ── 1. Verify ORP_SYNC is loaded ────────────────────
      if (!global.ORP_SYNC) {
        console.warn('[Bootstrap] ORP_SYNC not found — sync disabled');
        return;
      }

      // ── 2. Initialize SyncEngine for cross-tab state ─────
      if (global.SyncEngine && typeof global.SyncEngine.init === 'function') {
        try {
          global.SyncEngine.init();
          console.log('[Bootstrap] SyncEngine cross-tab sync ready');
        } catch (e) {
          console.error('[Bootstrap] SyncEngine.init() failed:', e);
        }
      }

      // ── 3. Verify Warden is available & primed ──────────
      if (global.Warden && typeof global.Warden.scan === 'function') {
        var wardenActive = global.ORP_SYNC.load('ness_warden_active', true);
        console.log('[Bootstrap] Warden available — active:', wardenActive);
      } else {
        console.warn('[Bootstrap] Warden not loaded');
      }

      // ── 4. Verify Coordinator if present ────────────────
      if (global.ORP_COORDINATOR) {
        var coordState = global.ORP_COORDINATOR.getState();
        console.log('[Bootstrap] Coordinator ready — mode:', coordState.mode);
      } else {
        console.log('[Bootstrap] Coordinator not loaded (expected on non-coordinator pages)');
      }

      // ── 5. Verify Registry availability ─────────────────
      if (global.ORP_REGISTRY) {
        var snap = global.ORP_REGISTRY.snapshot();
        var agentCount = Object.keys(snap).length;
        console.log('[Bootstrap] Registry ready —', agentCount, 'agents registered');
      }

      // ── 6. Subscribe to global sync events ──────────────
      global.addEventListener('orp-settings-update', function (e) {
        if (!e || !e.detail) return;
        var key = e.detail.key;
        var value = e.detail.value;

        // Log critical state changes
        if (key === 'ness_pressure' || key === 'ness_warden_active') {
          console.log('[Bootstrap] ORP_SYNC update:', key, '=', value);
        }
      });

      // ── 7. Inter-page verification hook ─────────────────
      // Any page can publish its readiness state
      global.addEventListener('orp-page-ready', function (e) {
        if (!e || !e.detail) return;
        var pageName = e.detail.page;
        var hasSync = e.detail.hasSync;
        var hasWarden = e.detail.hasWarden;
        var hasCoordinator = e.detail.hasCoordinator;
        console.log('[Bootstrap] Page ready:', pageName, {
          sync: hasSync,
          warden: hasWarden,
          coordinator: hasCoordinator,
        });
      });

      // ── 8. Publish this page's readiness ────────────────
      this._publishPageReady();

      console.log('[Bootstrap] All systems initialized');
    },

    /**
     * Publish this page's capability state for inter-page verification.
     */
    _publishPageReady: function () {
      var pageName = (function () {
        var href = window.location.href;
        var match = href.match(/\/([^\/?\#]+)\.html/);
        return match ? match[1] : 'unknown';
      })();

      var event = new CustomEvent('orp-page-ready', {
        detail: {
          page: pageName,
          timestamp: new Date().toISOString(),
          hasSync: !!global.ORP_SYNC,
          hasSyncEngine: !!global.SyncEngine,
          hasWarden: !!global.Warden,
          hasCoordinator: !!global.ORP_COORDINATOR,
          hasRegistry: !!global.ORP_REGISTRY,
          hasRuntimeOverlay: !!global.RuntimeOverlay,
        },
      });
      global.dispatchEvent(event);
    },

    /**
     * Verify inter-sync consistency: ensure all known keys in ORP_SYNC
     * match their session counterparts (if SyncEngine is active).
     */
    verifySync: function () {
      if (!global.ORP_SYNC || !global.SyncEngine) {
        console.warn('[Bootstrap.verifySync] ORP_SYNC or SyncEngine not available');
        return { valid: false, reason: 'Missing dependency' };
      }

      var snapshot = global.ORP_SYNC.snapshot();
      var keys = Object.keys(snapshot);
      var mismatches = [];

      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var persistedValue = snapshot[key];
        var sessionValue = global.SyncEngine.session.get(key);

        if (JSON.stringify(persistedValue) !== JSON.stringify(sessionValue)) {
          mismatches.push({
            key: key,
            persisted: persistedValue,
            session: sessionValue,
          });
        }
      }

      var result = {
        valid: mismatches.length === 0,
        checked: keys.length,
        mismatches: mismatches,
      };

      if (mismatches.length > 0) {
        console.warn('[Bootstrap.verifySync] Mismatches detected:', result);
      } else {
        console.log('[Bootstrap.verifySync] All keys consistent');
      }

      return result;
    },

    /**
     * Force re-sync from ORP_SYNC to SyncEngine session.
     * Useful after page navigation or coordinator state changes.
     */
    resync: function () {
      if (!global.ORP_SYNC || !global.SyncEngine) {
        console.warn('[Bootstrap.resync] Missing dependency');
        return false;
      }

      var snapshot = global.ORP_SYNC.snapshot();
      var keys = Object.keys(snapshot);

      for (var i = 0; i < keys.length; i++) {
        global.SyncEngine.session.set(keys[i], snapshot[keys[i]]);
      }

      console.log('[Bootstrap.resync] Synced', keys.length, 'keys');
      return true;
    },

    /**
     * Get current sync status for debugging.
     */
    getStatus: function () {
      return {
        page: (function () {
          var match = window.location.href.match(/\/([^\/?\#]+)\.html/);
          return match ? match[1] : 'unknown';
        })(),
        hasSync: !!global.ORP_SYNC,
        hasSyncEngine: !!global.SyncEngine,
        hasWarden: !!global.Warden,
        hasCoordinator: !!global.ORP_COORDINATOR,
        hasRegistry: !!global.ORP_REGISTRY,
        timestamp: new Date().toISOString(),
      };
    },
  };

  global.PageBootstrap = PageBootstrap;

  // ── Auto-init: run on every page without requiring an explicit
  // call in HTML. Only coordinator.html had PageBootstrap.init()
  // in its inline script; all other pages never called it, leaving
  // Warden, Coordinator, and page-ready hooks silent.
  // DOMContentLoaded guard: PageBootstrap.init() only logs and
  // subscribes to events — safe before the DOM is fully parsed.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      PageBootstrap.init();
    });
  } else {
    PageBootstrap.init();
  }

}(window));
