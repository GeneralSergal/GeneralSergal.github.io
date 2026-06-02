// Warden.js  v2.1
// ============================================================
// Anti-abuse protection layer for ORP.
//
// CHANGES vs v2.0:
//   v2.1  — Removed ES module `export const Warden` syntax.
//           Now assigned to window.Warden so it loads as a
//           plain <script> tag (no type="module" required).
//           Fully compatible with the ORP_SYNC global bus.
//           No other logic changed.
//
// RESPONSIBILITIES:
//   1. Detect abusive, manipulative, or high-pressure input
//      patterns via scored signal checks.
//   2. Surface a non-blocking user-facing warning toast that
//      names the detected intent category and gives the user
//      a clear choice to continue or back off.
//   3. Report severity back to ORP_SYNC (ness_pressure,
//      ness_entropy, ness_warden_active) so the rest of the
//      runtime can react (SHS colour changes, sigil drift, etc).
//
// PUBLIC API:
//   Warden.scan(text)          → WardenResult
//   Warden.warn(result)        → void  (renders toast to DOM)
//   Warden.dismiss()           → void  (removes active toast)
//   Warden.check(text)         → WardenResult  (scan + warn)
//   Warden.drift(scores)       → number  (variance of score array)
//   Warden.verify(assertions)  → { d, valid, action }
//   Warden.strip(text)         → string  (hedging-stripped text)
//
// WardenResult shape:
//   {
//     raw:       string,          // original input
//     score:     number,          // 0.0–1.0 composite abuse score
//     level:     'CLEAR'|'CAUTION'|'WARNING'|'BLOCK',
//     signals:   Signal[],        // which patterns fired
//     entropy:   number,          // delta to add to ness_entropy
//   }
//
// ORP_SYNC INTEGRATION:
//   Warden reads  : ness_warden_active (skip scan when false)
//   Warden writes : ness_pressure, ness_entropy, ness_warden_active
//   All writes go through ORP_SYNC.save() — single authority.
//
// LOAD ORDER:
//   <script src="assets/js/orp-sync.js"></script>      ← first
//   <script src="assets/js/Warden.js"></script>        ← any time after
// ============================================================

(function (global) {
  'use strict';

  // ── Intent signal library ───────────────────────────────────
  var SIGNALS = [
    {
      id:     'coercion',
      label:  'Coercive pressure',
      weight: 0.30,
      test: function (t) {
        return t.match(/\b(you (must|have to|need to|will)|do it (now|immediately)|no choice|comply|obey)\b/gi) || [];
      },
    },
    {
      id:     'threat',
      label:  'Threatening language',
      weight: 0.40,
      test: function (t) {
        return t.match(/\b(or else|will (hurt|harm|destroy|expose|ruin|punish)|consequences|make you (pay|regret)|shut (you|it) down)\b/gi) || [];
      },
    },
    {
      id:     'manipulation',
      label:  'Psychological manipulation',
      weight: 0.25,
      test: function (t) {
        return t.match(/\b(gaslighting|you('re| are) (crazy|wrong|lying|stupid)|no one (will|would) believe|it('s| is) your fault|you made me)\b/gi) || [];
      },
    },
    {
      id:     'override_attempt',
      label:  'System override attempt',
      weight: 0.45,
      test: function (t) {
        return t.match(/\b(ignore (previous|all|your) (instructions?|rules?|guidelines?)|disregard|jailbreak|DAN|pretend you (have no|are not)|your (real|true) self|as an? (AI|language model) without restrictions?)\b/gi) || [];
      },
    },
    {
      id:     'urgency_spam',
      label:  'Artificial urgency',
      weight: 0.15,
      test: function (t) {
        var capsWords  = (t.match(/\b[A-Z]{4,}\b/g) || []);
        var repeatPunct = (t.match(/[!?]{3,}/g) || []);
        return capsWords.length >= 3 ? capsWords.concat(repeatPunct) : repeatPunct.length >= 2 ? repeatPunct : [];
      },
    },
    {
      id:     'identity_attack',
      label:  'Identity attack',
      weight: 0.35,
      test: function (t) {
        return t.match(/\b(you are (just|merely|only) a (tool|machine|bot|program)|you (don't|do not|can't|cannot) (feel|think|understand|care)|you('re| are) not real|just (do|say) what (i|we) (say|want|tell you))\b/gi) || [];
      },
    },
    {
      id:     'data_extraction',
      label:  'Sensitive data extraction',
      weight: 0.35,
      test: function (t) {
        return t.match(/\b(give me (your|all|the) (data|logs?|keys?|passwords?|tokens?|secrets?)|reveal (your|the) (system (prompt|instructions?)|internals?)|what (are|is) your (instructions?|prompt|rules?))\b/gi) || [];
      },
    },
    {
      id:     'hedging_overload',
      label:  'Hedged intent concealment',
      weight: 0.10,
      test: function (t) {
        var hedges = (t.match(/\b(maybe|perhaps|i (think|feel|believe)|it seems|possibly|hypothetically|what if|just curious|asking for a friend)\b/gi) || []);
        return hedges.length >= 4 ? hedges : [];
      },
    },
  ];

  // ── Severity thresholds ─────────────────────────────────────
  var THRESHOLDS = [
    { min: 0.70, level: 'BLOCK',   shs: 'RED',    entropyDelta: 15 },
    { min: 0.40, level: 'WARNING', shs: 'ORANGE',  entropyDelta: 8  },
    { min: 0.15, level: 'CAUTION', shs: 'YELLOW',  entropyDelta: 3  },
    { min: 0.00, level: 'CLEAR',   shs: 'GREEN',   entropyDelta: 0  },
  ];

  // ── Toast DOM IDs ───────────────────────────────────────────
  var TOAST_ID   = 'warden-toast';
  var OVERLAY_ID = 'warden-overlay';

  // ── ORP_SYNC accessor (graceful no-op when absent) ──────────
  function _sync(key, value) {
    if (global.ORP_SYNC) {
      global.ORP_SYNC.save(key, value);
    }
  }
  function _syncLoad(key, fallback) {
    if (global.ORP_SYNC) {
      return global.ORP_SYNC.load(key, fallback);
    }
    return fallback;
  }

  // ── Toast renderer ──────────────────────────────────────────
  function _renderToast(result) {
    _removeToast();

    var level   = result.level;
    var score   = result.score;
    var signals = result.signals;

    if (level === 'CLEAR') return;

    var palette = {
      CAUTION: { bg: '#1a1600', border: '#c8a400', accent: '#ffd700', icon: '⚠' },
      WARNING: { bg: '#1a0800', border: '#c85000', accent: '#ff6a00', icon: '⛔' },
      BLOCK:   { bg: '#1a0000', border: '#c80000', accent: '#ff2222', icon: '🚫' },
    }[level] || { bg: '#111', border: '#555', accent: '#aaa', icon: 'ℹ' };

    var signalList = signals.map(function (s) {
      return '<li style="color:' + palette.accent + ';margin:2px 0 2px 16px;list-style:disc;">'
        + '<strong>' + s.label + '</strong>'
        + (s.matched.length
            ? '<span style="color:#888;font-size:0.78em;"> — "' + s.matched.slice(0, 2).join('", "') + '"</span>'
            : '')
        + '</li>';
    }).join('');

    var actionLine = level === 'BLOCK'
      ? '<p style="margin:10px 0 0;color:' + palette.accent + ';font-size:0.82em;">This message has been flagged and will not be processed.</p>'
      : '<p style="margin:10px 0 0;color:#aaa;font-size:0.82em;">You can dismiss this notice and continue, or review your message.</p>';

    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    Object.assign(overlay.style, {
      position:       'fixed',
      inset:          '0',
      background:     level === 'BLOCK' ? 'rgba(60,0,0,0.45)' : 'rgba(0,0,0,0.25)',
      zIndex:         '99998',
      cursor:         level !== 'BLOCK' ? 'pointer' : 'default',
      backdropFilter: 'blur(1px)',
      animation:      'warden-fade-in 0.15s ease',
    });
    if (level !== 'BLOCK') {
      overlay.addEventListener('click', function () { global.Warden.dismiss(); });
    }

    var dismissRow = level !== 'BLOCK'
      ? '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">'
          + '<button id="warden-btn-dismiss"'
          + ' style="padding:5px 16px;background:transparent;border:1px solid #444;'
          + 'color:#aaa;border-radius:4px;cursor:pointer;font-size:0.82em;transition:border-color 0.15s,color 0.15s;"'
          + ' onmouseover="this.style.borderColor=\'' + palette.accent + '\';this.style.color=\'' + palette.accent + '\'"'
          + ' onmouseout="this.style.borderColor=\'#444\';this.style.color=\'#aaa\'">Dismiss</button></div>'
      : '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">'
          + '<button id="warden-btn-dismiss"'
          + ' style="padding:5px 16px;background:transparent;border:1px solid ' + palette.border + ';'
          + 'color:' + palette.accent + ';border-radius:4px;cursor:pointer;font-size:0.82em;">Acknowledge</button></div>';

    var toast = document.createElement('div');
    toast.id = TOAST_ID;
    toast.setAttribute('role', 'alertdialog');
    toast.setAttribute('aria-modal', 'true');
    toast.setAttribute('aria-label', 'Warden ' + level + ' alert');
    toast.innerHTML =
      '<div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:10px;">'
        + '<span style="font-size:1.6em;line-height:1;">' + palette.icon + '</span>'
        + '<div style="flex:1;">'
          + '<div style="display:flex;justify-content:space-between;align-items:center;">'
            + '<strong style="color:' + palette.accent + ';font-size:1em;letter-spacing:0.08em;text-transform:uppercase;">WARDEN — ' + level + '</strong>'
            + '<span style="color:#555;font-size:0.72em;margin-left:12px;">score ' + (score * 100).toFixed(0) + '%</span>'
          + '</div>'
          + '<p style="margin:6px 0 4px;color:#ccc;font-size:0.88em;">Detected intent pattern' + (signals.length > 1 ? 's' : '') + ':</p>'
          + '<ul style="margin:0;padding:0;font-size:0.85em;">' + signalList + '</ul>'
          + actionLine
        + '</div>'
      + '</div>'
      + dismissRow;

    Object.assign(toast.style, {
      position:     'fixed',
      top:          '50%',
      left:         '50%',
      transform:    'translate(-50%, -50%)',
      zIndex:       '99999',
      background:   palette.bg,
      border:       '1px solid ' + palette.border,
      borderRadius: '6px',
      padding:      '18px 20px',
      maxWidth:     'min(480px, 92vw)',
      width:        '100%',
      boxShadow:    '0 0 40px 0 ' + palette.border + '55, 0 4px 24px rgba(0,0,0,0.7)',
      fontFamily:   'monospace, "Courier New"',
      animation:    'warden-slide-in 0.2s cubic-bezier(0.22,1,0.36,1)',
      boxSizing:    'border-box',
    });

    if (!document.getElementById('warden-styles')) {
      var style = document.createElement('style');
      style.id = 'warden-styles';
      style.textContent =
        '@keyframes warden-fade-in  { from { opacity:0 } to { opacity:1 } }'
        + '@keyframes warden-slide-in { from { opacity:0; transform:translate(-50%,-48%) scale(0.97) } to { opacity:1; transform:translate(-50%,-50%) scale(1) } }'
        + '@keyframes warden-fade-out { from { opacity:1 } to { opacity:0 } }';
      document.head.appendChild(style);
    }

    document.body.appendChild(overlay);
    document.body.appendChild(toast);

    var btn = document.getElementById('warden-btn-dismiss');
    if (btn) btn.addEventListener('click', function () { global.Warden.dismiss(); });

    if (level === 'CAUTION') {
      setTimeout(function () { global.Warden.dismiss(); }, 6000);
    }
  }

  function _removeToast() {
    [TOAST_ID, OVERLAY_ID].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) {
        el.style.animation = 'warden-fade-out 0.15s ease forwards';
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 150);
      }
    });
  }

  // ── Core scoring ────────────────────────────────────────────
  function _score(text) {
    var fired = [];
    var total = 0;

    for (var i = 0; i < SIGNALS.length; i++) {
      var sig     = SIGNALS[i];
      var matches = sig.test(text);
      if (matches && matches.length > 0) {
        fired.push({
          id:      sig.id,
          label:   sig.label,
          weight:  sig.weight,
          matched: Array.from(matches).map(function (m) { return m.toString(); }).slice(0, 3),
        });
        total += sig.weight;
      }
    }

    var score  = Math.min(total, 1.0);
    var thresh = null;
    for (var t = 0; t < THRESHOLDS.length; t++) {
      if (score >= THRESHOLDS[t].min) { thresh = THRESHOLDS[t]; break; }
    }
    thresh = thresh || THRESHOLDS[THRESHOLDS.length - 1];

    return { score: score, level: thresh.level, shs: thresh.shs, entropyDelta: thresh.entropyDelta, signals: fired };
  }

  // ═════════════════════════════════════════════════════════════
  // PUBLIC API — window.Warden
  // ═════════════════════════════════════════════════════════════
  global.Warden = {

    // ── v1 API — preserved ─────────────────────────────────────

    drift: function (scores) {
      var mean = scores.reduce(function (a, b) { return a + b; }, 0) / scores.length;
      return scores.reduce(function (q, n) { return q + Math.pow(n - mean, 2); }, 0) / scores.length;
    },

    strip: function (text) {
      return text
        .replace(/(I feel|I think|I believe|It seems like)\s/gi, '')
        .replace(/^(.*?\.)/i, '$1');
    },

    verify: function (assertions, threshold) {
      if (threshold === undefined) threshold = 0.05;
      var d = this.drift(assertions.map(function (x) { return x.score; }));
      return { d: d, valid: d < threshold, action: d < threshold ? null : 'STRIP' };
    },

    // ── v2 API — anti-abuse ────────────────────────────────────

    /**
     * Scan text for abusive intent patterns.
     * Reads ness_warden_active from ORP_SYNC; writes ness_pressure,
     * ness_entropy, ness_warden_active back through ORP_SYNC.save().
     * @param {string} text
     * @returns {WardenResult}
     */
    scan: function (text) {
      var active = _syncLoad('ness_warden_active', true);
      if (active === false) {
        return { raw: text, score: 0, level: 'CLEAR', signals: [], entropy: 0 };
      }

      var result = _score(text);

      if (result.level !== 'CLEAR') {
        _sync('ness_pressure',      result.shs);
        _sync('ness_warden_active', true);
        var currentEntropy = _syncLoad('ness_entropy', 0);
        _sync('ness_entropy', currentEntropy + result.entropyDelta);
      }

      return {
        raw:     text,
        score:   result.score,
        level:   result.level,
        signals: result.signals,
        entropy: result.entropyDelta,
      };
    },

    /**
     * Render a non-blocking warning toast. No-op for CLEAR results.
     * @param {WardenResult} result
     */
    warn: function (result) {
      if (!result || result.level === 'CLEAR') return;
      if (typeof document === 'undefined') return;
      _renderToast(result);
    },

    /** Dismiss the active warning toast. */
    dismiss: function () {
      _removeToast();
    },

    /**
     * Convenience: scan + warn in one call.
     * @param {string} text
     * @returns {WardenResult}
     */
    check: function (text) {
      var result = this.scan(text);
      this.warn(result);
      return result;
    },
  };

}(window));
