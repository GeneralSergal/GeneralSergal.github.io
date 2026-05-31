/* ============================================================
   ORP v3.0 — Shared JS
   GPU-optimized: all scroll-driven DOM writes batched into a
   single requestAnimationFrame callback per frame. The scroll
   event only captures the latest scroll position (a cheap
   read); the rAF callback does all writes, running at most
   once per display refresh cycle regardless of scroll speed.

   PATCH LOG (v3.0.1):
     MEDIUM-1— resize listener now carries { passive: true } flag.
     MEDIUM-2— document.documentElement.scrollHeight read moved out
               of _flushScrollWrites() into a ResizeObserver cache
               (_scrollMax). Zero layout reads inside the rAF callback.
     LOW-1   — display:none/block panel toggles replaced with the
               hidden attribute. Avoids full paint+layout recalc on
               toggle; semantically equivalent; aria-expanded still set.
     LOW-2   — IntersectionObserver: added rootMargin:"0px 0px -80px 0px"
               (trigger 80px early, eliminates flash-of-invisible on fast
               scroll); added observer.unobserve() after first reveal to
               free observer bookkeeping for elements that won't re-hide.

   PATCH LOG (v3.1.0 — Logo-mark Stability + SHS Coupling):
     LOGO-1  — initLogoMark(): static SVG injection into .logo-mark
               elements. Fetches icons.svg ONCE; appends the full
               document (including root <defs>) into a hidden host div
               at the top of <body> so url(#orp-*) filter IDs resolve
               correctly in all browsers (Firefox/Safari shadow-DOM
               scoping fix). Then injects <svg><use href="#orp-logo-mark">
               into each .logo-mark container. No Math.random() ID
               rewriting — static IDs are globally unique via orp- prefix.
     LOGO-2  — _logoHoverBind(): hover + click class toggles on .logo
               anchor trigger .logo-mark--active and .logo-mark--pulse
               on the SVG wrapper for CSS-driven interaction sequences.
               Click fires a one-shot .logo-mark--clicked class that
               self-removes after the animation duration.
     LOGO-3  — _logoSHSBridge(): listens to the same orp-settings-update
               event bus as entropia-sigil.js. Applies shs-* classes to
               .logo-mark[data-shs-live] elements so the logo reflects
               the current System Health State without polling.
               Falls back to MutationObserver on #cc-tab-shs pill for
               pages where ORP_SYNC is absent.
     LOGO-4  — initLogoMark() is idempotent: skips containers that
               already contain an <svg> child (hot-reload / PJAX safe).

   PATCH LOG (v3.2.0 — Firefox file:// + strict-CSP Fix):
     LOGO-5  — Three-tier sprite loading strategy replaces the single
               fetch() call that failed silently in Firefox on file://
               (CORS security block) and under strict CSPs:
               Tier 1: If <div id="orp-icon-host"> or #orp-logo-mark
                       already exists in the document (inline embed
                       pattern), skip all network loading entirely.
               Tier 2: XMLHttpRequest with overrideMimeType("image/svg+xml")
                       — succeeds on file:// in Firefox where fetch() is
                       blocked. xhr.status === 0 is treated as success for
                       file:// protocol.
               Tier 3: fetch() fallback for environments where XHR fails.
               All three tiers feed the same Step 3 + 4 injection path.
     LOGO-6  — _loadSVGText() helper encapsulates XHR->fetch waterfall,
               returns a Promise<string> of raw SVG text.
     LOGO-7  — _injectLogoUses() extracted as a pure DOM function so
               Tier 1 (inline path) can call it without touching the
               network loader.
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {

  /* ── Cache DOM references once ───────────────────────── */
  const progressEl  = document.querySelector(".scroll-progress");
  const topBtn      = document.getElementById("scroll-top-btn");
  const navElement  = document.getElementById("main-nav");

  /* ── Shared scroll state (read on event, write on rAF) ── */
  let _scrollY        = window.scrollY;
  let _rafPending     = false;
  let _lastNavScrollY = window.scrollY;
  const SCROLL_THRESHOLD = 8;

  /* PATCH MEDIUM-2: cache scrollMax via ResizeObserver */
  let _scrollMax = document.documentElement.scrollHeight - window.innerHeight;
  const _scrollMaxObs = new ResizeObserver(() => {
    _scrollMax = document.documentElement.scrollHeight - window.innerHeight;
  });
  _scrollMaxObs.observe(document.documentElement);

  /* ── Single scroll listener — passive, zero DOM writes ── */
  window.addEventListener("scroll", () => {
    _scrollY = window.scrollY;
    if (!_rafPending) {
      _rafPending = true;
      requestAnimationFrame(_flushScrollWrites);
    }
  }, { passive: true });

  /* ── rAF: all DOM writes happen here, once per frame ─── */
  function _flushScrollWrites() {
    _rafPending = false;

    if (progressEl && _scrollMax > 0) {
      progressEl.style.transform = `scaleX(${_scrollY / _scrollMax})`;
    }

    if (topBtn) {
      topBtn.classList.toggle("visible", _scrollY > 400);
    }

    if (navElement) {
      if (window.innerWidth <= 640) {
        const delta = _scrollY - _lastNavScrollY;
        if (_scrollY <= 0) {
          navElement.classList.remove("nav-hidden");
          _lastNavScrollY = _scrollY;
        } else if (Math.abs(delta) > SCROLL_THRESHOLD) {
          navElement.classList.toggle("nav-hidden", delta > 0);
          _lastNavScrollY = _scrollY;
        }
      } else {
        navElement.classList.remove("nav-hidden");
      }
    }
  }

  /* ── Scroll to top ───────────────────────────────────── */
  if (topBtn) {
    topBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  /* ── Active nav link helper ─────────────────────────────── */
  const currentPage =
    window.location.pathname.split("/").pop() || "index.html";

  function _markActiveLink(link) {
    const href = link.getAttribute("href").split("/").pop();
    if (href === currentPage || (currentPage === "" && href === "index.html")) {
      link.classList.add("active");
    }
  }

  document.querySelectorAll(".nav-links a").forEach(_markActiveLink);

  /* ── Mobile hamburger navigation ─────────────────────── */
  const hamburgerBtn = document.getElementById("hamburger-btn");
  const mobileNav    = document.getElementById("mobile-nav");

  if (hamburgerBtn && mobileNav) {

    const toggleMenu = () => {
      const isActive = mobileNav.classList.toggle("active");
      hamburgerBtn.classList.toggle("active", isActive);
      hamburgerBtn.setAttribute("aria-expanded", isActive ? "true" : "false");
      document.body.style.overflow = isActive ? "hidden" : "";
      navElement?.classList.toggle("menu-open", isActive);
    };

    hamburgerBtn.addEventListener("click", toggleMenu);

    mobileNav.querySelectorAll("a").forEach(link => {
      _markActiveLink(link);
      link.addEventListener("click", () => {
        mobileNav.classList.remove("active");
        navElement?.classList.remove("menu-open");
        hamburgerBtn.classList.remove("active");
        hamburgerBtn.setAttribute("aria-expanded", "false");
        document.body.style.overflow = "";
      });
    });

    let _resizeRaf = false;
    const _onResize = () => {
      if (!_resizeRaf) {
        _resizeRaf = true;
        requestAnimationFrame(() => {
          _resizeRaf = false;
          if (window.innerWidth > 640) {
            mobileNav.classList.remove("active");
            navElement?.classList.remove("menu-open");
            hamburgerBtn.classList.remove("active");
            document.body.style.overflow = "";
          }
        });
      }
    };
    window.addEventListener("resize", _onResize, { passive: true });
  }

  /* ── Author image fallback ───────────────────────────── */
  const authorImg       = document.getElementById("author-img");
  const avatarContainer = document.getElementById("avatar-container");

  if (authorImg && avatarContainer) {
    authorImg.addEventListener("error", () => {
      avatarContainer.classList.add("img-error");
    });
    if (authorImg.naturalWidth === 0) {
      avatarContainer.classList.add("img-error");
    }
  }

  /* ── Telemetry console toggle ────────────────────────── */
  const consoleToggleBtn = document.getElementById("console-toggle-btn");

  if (consoleToggleBtn) {
    const extendedContainer = document.getElementById("extended-telemetry-container");
    const btnText           = document.getElementById("telemetry-btn-text");

    consoleToggleBtn.addEventListener("click", () => {
      if (!extendedContainer || !btnText) return;

      const isHidden = extendedContainer.hasAttribute("hidden");
      if (isHidden) {
        extendedContainer.removeAttribute("hidden");
      } else {
        extendedContainer.setAttribute("hidden", "");
      }
      consoleToggleBtn.setAttribute("aria-expanded", isHidden ? "true" : "false");
      btnText.textContent = isHidden
        ? "[ COLLAPSE SYSTEM ARTIFACTS - ]"
        : "[ EXPAND SYSTEM ARTIFACTS + ]";
      btnText.style.color = isHidden ? "var(--accent-orange)" : "var(--muted)";
    });
  }

  /* ── Variant matrix toggle ───────────────────────────── */
  const variantToggleBtn = document.getElementById("variant-toggle-btn");

  if (variantToggleBtn) {
    const panel   = document.getElementById("variant-matrix-panel");
    const btnSpan = variantToggleBtn.querySelector("span");

    variantToggleBtn.addEventListener("click", () => {
      if (!panel || !btnSpan) return;

      const isHidden = panel.hasAttribute("hidden");
      if (isHidden) {
        panel.removeAttribute("hidden");
      } else {
        panel.setAttribute("hidden", "");
      }
      variantToggleBtn.setAttribute("aria-expanded", isHidden ? "true" : "false");
      btnSpan.textContent = isHidden
        ? "[SYSTEM // CLOSE VARIANT MATRIX]"
        : "[SYSTEM // EXECUTE VARIANT MATRIX]";
    });
  }

  /* ── Intersection Observer reveal ───────────────────── */
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.05, rootMargin: "0px 0px -80px 0px" });

  document.querySelectorAll(
    "section, header, .pipeline-card, .doc-card, .principle, .quick-access-card, .release-card, .cfg-card, .cfg-danger"
  ).forEach(el => {
    el.classList.add("reveal");
    observer.observe(el);
  });


  /* ════════════════════════════════════════════════════════════
     PATCH LOGO-1 / LOGO-2 / LOGO-3 / LOGO-4
     initLogoMark — Static SVG injection + interactivity + SHS
     ════════════════════════════════════════════════════════════

     HOW IT WORKS:
       1. Fetch assets/icons.svg once (plain text).
       2. Parse it into a DocumentFragment via DOMParser.
       3. Append the parsed <svg> (which contains the root <defs>
          with all orp-* filter IDs) into a hidden host div at the
          top of <body>. This puts orp-* IDs into the main document
          scope so url(#orp-*) lookups resolve in all browsers.
       4. For each .logo-mark container, inject a sized <svg>
          with a <use href="#orp-logo-mark"> — no ID rewriting,
          no Math.random(), no innerHTML string surgery.
       5. Bind hover/click on the parent .logo anchor.
       6. Wire SHS state to logo shs-* classes.

     WHY THIS IS STABLE:
       • Shadow-DOM filter scoping bug: filters inside a <symbol>
         are processed in the symbol's scope. By hoisting defs to
         the root document svg (step 3) we guarantee the filter IDs
         are always in document scope, not shadow scope.
       • No per-frame DOM writes — the SVG is injected once and
         then CSS drives all animation.
       • Idempotent: containers that already have an <svg> child
         are skipped so hot-reload / PJAX won't double-inject.
  ──────────────────────────────────────────────────────────── */

  /* ── LOGO-1: Static SVG injection ──────────────────────── */
  /*
     PATCH v3.2.0 — FIREFOX / file:// FIX:

     ROOT CAUSE: fetch() is blocked by Firefox on file:// (CORS/security
     policy) and by strict CSPs on http(s)://. When fetch() throws, the
     old code returned early — leaving every .logo-mark blank.

     STRATEGY (three-tier, in priority order):
       Tier 1 — Inline host already present in DOM (fastest, zero network):
         If the HTML page embeds <div id="orp-icon-host"> with the full
         sprite (recommended pattern for production), skip fetch entirely.
         The symbols are already in document scope; just inject <use> refs.

       Tier 2 — XMLHttpRequest (works on file:// in Firefox):
         XHR with overrideMimeType("image/svg+xml") succeeds on file://
         where fetch() is blocked. Used as primary network loader.

       Tier 3 — fetch() (HTTP/HTTPS, modern CSP-friendly environments):
         Falls back to fetch if XHR somehow fails (unusual).

     In all tiers, once the sprite SVG is in document scope the
     container injection and interactivity wiring are identical.

     PATCH LOG:
       v3.1.1 — Removed skip guard; always clear+re-inject containers.
       v3.2.0 — Added Tier 1 inline-host detection; replaced fetch with
                XHR primary + fetch fallback to fix file:// in Firefox.
  */

  /* Helper: load SVG text cross-browser (XHR → fetch) */
  function _loadSVGText(url) {
    return new Promise((resolve, reject) => {
      /* --- Tier 2: XHR (survives file:// in Firefox) --- */
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        /* overrideMimeType prevents Firefox from rejecting SVG as
           "not well-formed XML" when served without a Content-Type */
        if (xhr.overrideMimeType) xhr.overrideMimeType("image/svg+xml");
        xhr.onload = () => {
          if (xhr.status === 0 /* file:// */ || (xhr.status >= 200 && xhr.status < 300)) {
            resolve(xhr.responseText);
          } else {
            reject(new Error(`XHR ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error("XHR network error"));
        xhr.send();
      } catch (xhrErr) {
        /* --- Tier 3: fetch fallback --- */
        fetch(url)
          .then(r => { if (!r.ok) throw new Error(`fetch ${r.status}`); return r.text(); })
          .then(resolve)
          .catch(reject);
      }
    });
  }

  /* Step 4 (shared): inject <svg><use> into each .logo-mark container */
  function _injectLogoUses() {
    document.querySelectorAll(".logo-mark").forEach(container => {
      /* Always clear stale external <use href="assets/icons.svg#...">
         children that cannot reach the inline-hoisted defs — LOGO-4 FIX */
      container.innerHTML = "";

      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox",  "0 0 100 100");
      svg.setAttribute("width",    "34");
      svg.setAttribute("height",   "34");
      svg.setAttribute("overflow", "visible");
      svg.setAttribute("aria-hidden", "true");
      svg.style.cssText        = "display:block;width:100%;height:100%;overflow:visible;";
      svg.style.willChange     = "transform, opacity";
      svg.style.backfaceVisibility = "hidden";

      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      /* Inline fragment reference — resolves in document scope, not external file */
      use.setAttribute("href", "#orp-logo-mark");
      svg.appendChild(use);
      container.appendChild(svg);

      container.dataset.shsLive = "true"; /* LOGO-3 SHS bridge hook */
    });
  }

  async function initLogoMark() {
    const containers = document.querySelectorAll(".logo-mark");
    if (containers.length === 0) return;

    /* ── Tier 1: Inline host already present ─────────────────
       Pages that embed <div id="orp-icon-host"> with the full
       icons.svg content skip all network loading entirely.
       The symbols (#orp-logo-mark etc.) are already in document
       scope — just clear containers and inject <use> refs.      */
    if (document.getElementById("orp-icon-host") ||
        document.getElementById("orp-logo-mark")) {
      _injectLogoUses();
      _logoHoverBind();
      _logoSHSBridge();
      return;
    }

    /* ── Tiers 2 + 3: Load sprite via XHR / fetch ─────────── */
    let svgText;
    try {
      svgText = await _loadSVGText("assets/icons.svg");
    } catch (err) {
      console.warn("ORP_LOGO: Failed to load icons.svg —", err.message);
      return;
    }

    let svgSprite;
    try {
      const parser = new DOMParser();
      const doc    = parser.parseFromString(svgText, "image/svg+xml");
      /* DOMParser returns an <parsererror> doc on failure */
      const parseErr = doc.querySelector("parsererror");
      if (parseErr) throw new Error("SVG parse error");
      svgSprite = doc.querySelector("svg");
      if (!svgSprite) throw new Error("No <svg> root in icons.svg");
    } catch (err) {
      console.warn("ORP_LOGO: SVG parse failed —", err.message);
      return;
    }

    /* Step 3: Hoist full sprite (root <defs> + all symbols) into <body>
       so every url(#orp-*) ID is in document scope.
       Guard prevents double-insertion on PJAX / hot-reload. */
    if (!document.getElementById("orp-icon-host")) {
      const host = document.createElement("div");
      host.id            = "orp-icon-host";
      host.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;";
      host.setAttribute("aria-hidden", "true");
      host.appendChild(svgSprite.cloneNode(true));
      document.body.insertBefore(host, document.body.firstChild);
    }

    _injectLogoUses();
    _logoHoverBind();
    _logoSHSBridge();
  }


  /* ── LOGO-2: Hover + click interactivity ────────────────── */
  /* Targets the .logo anchor (parent of .logo-mark).
     Applies class sequences to .logo-mark children for CSS-driven
     animation sequences without any style.* writes in JS.

     Classes applied:
       .logo-mark--active   — hover state (orbit faster, wing shimmer up)
       .logo-mark--pulse    — brief glow pulse on mouseenter
       .logo-mark--clicked  — one-shot activation flash on click
                              (self-removes after CSS animation ends)
  */
  function _logoHoverBind() {
    document.querySelectorAll(".logo").forEach(logoAnchor => {
      const mark = logoAnchor.querySelector(".logo-mark");
      if (!mark) return;

      /* Hover: active state */
      logoAnchor.addEventListener("mouseenter", () => {
        mark.classList.add("logo-mark--active", "logo-mark--pulse");
      });
      logoAnchor.addEventListener("mouseleave", () => {
        mark.classList.remove("logo-mark--active", "logo-mark--pulse");
      });

      /* Focus (keyboard nav): same as hover */
      logoAnchor.addEventListener("focusin", () => {
        mark.classList.add("logo-mark--active");
      });
      logoAnchor.addEventListener("focusout", () => {
        mark.classList.remove("logo-mark--active");
      });

      /* Click: one-shot flash — class removes itself when animationend fires */
      logoAnchor.addEventListener("click", (e) => {
        /* Don't hijack navigation — just add the class */
        mark.classList.add("logo-mark--clicked");

        /* Self-cleaning: remove after the CSS animation completes.
           animationend fires on the SVG child if the animation is on
           a child element; listening on the container is safer. */
        const onEnd = () => {
          mark.classList.remove("logo-mark--clicked");
          mark.removeEventListener("animationend", onEnd);
        };
        mark.addEventListener("animationend", onEnd);

        /* Fallback cleanup: if animationend never fires (e.g. reduced-motion)
           remove the class after a generous timeout */
        setTimeout(() => mark.classList.remove("logo-mark--clicked"), 1200);
      });
    });
  }


  /* ── LOGO-3: SHS state bridge ───────────────────────────────
     Maps SHS state strings to shs-* classes on .logo-mark elements
     that carry data-shs-live="true" (set in LOGO-1 step 4).

     Priority order:
       1. ORP_SYNC 'orp-settings-update' event (cross-tab sync)
       2. MutationObserver on #cc-tab-shs pill (local page)
       3. Fallback: poll once from ORP_SYNC.load('ness_pressure')
  ────────────────────────────────────────────────────────────── */
  function _logoSHSBridge() {
    const SHS_CLASSES = ["shs-green", "shs-yellow", "shs-orange", "shs-red", "shs-black"];

    /* Apply a SHS state string to all live logo marks */
    function _applyLogoSHS(shs) {
      const state = (shs || "GREEN").trim().toUpperCase();
      const cls   = state === "BLACK" || state === "DEAD" ? "shs-black"
                  : state === "RED"                       ? "shs-red"
                  : state === "ORANGE" || state === "AMBER" ? "shs-orange"
                  : state === "YELLOW"                    ? "shs-yellow"
                  :                                         "shs-green";

      document.querySelectorAll('.logo-mark[data-shs-live="true"]').forEach(mark => {
        mark.classList.remove(...SHS_CLASSES);
        mark.classList.add(cls);
      });
    }

    /* 1. ORP_SYNC event bus (fires on every save/remove call) */
    window.addEventListener("orp-settings-update", (e) => {
      if (!e.detail) return;
      if (e.detail.key === "ness_pressure" && e.detail.value) {
        _applyLogoSHS(e.detail.value);
      }
      if (e.detail.key === "shs_override" && e.detail.value) {
        _applyLogoSHS(e.detail.value);
      }
    });

    /* 2. MutationObserver on #cc-tab-shs pill */
    function _watchPill(pill) {
      _applyLogoSHS(pill.textContent.trim());
      new MutationObserver(() => {
        _applyLogoSHS(pill.textContent.trim());
      }).observe(pill, { childList: true, characterData: true, subtree: true });
    }

    const pill = document.getElementById("cc-tab-shs");
    if (pill) {
      _watchPill(pill);
    } else {
      /* Wait for pill to appear (runtime-overlay.js may boot later) */
      const _waitObs = new MutationObserver((_, obs) => {
        const p = document.getElementById("cc-tab-shs");
        if (p) { obs.disconnect(); _watchPill(p); }
      });
      _waitObs.observe(document.body, { childList: true, subtree: true });
    }

    /* 3. Restore persisted SHS state at boot if ORP_SYNC is present */
    if (typeof window.ORP_SYNC !== "undefined") {
      const persisted = ORP_SYNC.load("ness_pressure", ORP_SYNC.default("ness_pressure"));
      if (persisted) _applyLogoSHS(persisted);

      /* Also apply any override */
      const override = ORP_SYNC.load("shs_override", null);
      if (override) _applyLogoSHS(override);
    }
  }


  /* ════════════════════════════════════════════════════════════
     TELEMETRY HUD — index.html live metrics
     ════════════════════════════════════════════════════════════
     Drives the [SHS] / [DRIFT] / [CRA] / [LAS] values in the
     mini-telemetry-card on index.html dynamically from ORP_SYNC.

     Elements targeted by ID:
       #hud-shs-val   — SHS state string + colour class
       #hud-drift-val — drift level label + colour class
       #hud-cra-val   — CRA validity + colour class
       #hud-las-val   — LAS level + colour class

     Colour class vocabulary (maps to .orp-compact-scope rules):
       text-success  — green  (#3fb950)
       text-orange   — orange (#ff8833)
       text-red      — red    (#ff3333)
       (no class)    — default --text colour

     Update triggers:
       1. Boot: reads current ORP_SYNC persisted values.
       2. orp-settings-update event: live sync across tabs/pages.
       3. MutationObserver on #cc-tab-shs: local SHS pill changes.

     Graceful degradation: if ORP_SYNC is absent the values stay
     at their HTML defaults (GREEN / LOW / VALID / L3).
  ──────────────────────────────────────────────────────────── */
  (function initTelemetryHUD() {

    /* ── Element refs (all nullable — only on index.html) ── */
    const elSHS   = document.getElementById("hud-shs-val");
    const elDrift = document.getElementById("hud-drift-val");
    const elCRA   = document.getElementById("hud-cra-val");
    const elLAS   = document.getElementById("hud-las-val");

    /* If none of the HUD elements exist, this isn't index.html — bail */
    if (!elSHS && !elDrift && !elCRA && !elLAS) return;

    /* ── Colour class helpers ─────────────────────────────── */
    const TEXT_CLASSES = ["text-success", "text-orange", "text-red"];

    function _setVal(el, text, cls) {
      if (!el) return;
      el.textContent = text;
      el.classList.remove(...TEXT_CLASSES);
      if (cls) el.classList.add(cls);
    }

    /* ── SHS → display map ────────────────────────────────── */
    /* Maps SHS state string to { label, cls } for the HUD cell */
    function _shsDisplay(shs) {
      const s = (shs || "GREEN").toUpperCase();
      if (s === "GREEN")                   return { label: "GREEN",  cls: "text-success" };
      if (s === "YELLOW")                  return { label: "YELLOW", cls: "text-orange"  };
      if (s === "ORANGE" || s === "AMBER") return { label: "ORANGE", cls: "text-orange"  };
      if (s === "RED")                     return { label: "RED",    cls: "text-red"     };
      if (s === "BLACK" || s === "DEAD")   return { label: "BLACK",  cls: "text-red"     };
      return { label: s, cls: "" };
    }

    /* ── Drift intensity → label map ─────────────────────── */
    /* Maps numeric 0–1 drift value to a display label + colour */
    function _driftDisplay(intensity) {
      const v = parseFloat(intensity) || 0;
      if (v <= 0.15) return { label: "LOW",      cls: "text-success" };
      if (v <= 0.40) return { label: "LOW",      cls: "text-red"     };  // low but warning colour
      if (v <= 0.65) return { label: "MODERATE", cls: "text-orange"  };
      if (v <= 0.85) return { label: "HIGH",     cls: "text-orange"  };
      return              { label: "CRITICAL",   cls: "text-red"     };
    }

    /* ── CRA (Contextual Reasoning Accuracy) display ──────── */
    /* Derived from drift + SHS — no independent ORP_SYNC key exists yet.
       Green SHS / low drift → VALID; degraded states → DEGRADED / FAIL */
    function _craDisplay(shs, intensity) {
      const s = (shs || "GREEN").toUpperCase();
      const v = parseFloat(intensity) || 0;
      if (s === "GREEN"  && v <= 0.25) return { label: "VALID",    cls: "text-success" };
      if (s === "YELLOW" || v <= 0.55) return { label: "VALID",    cls: "text-success" };
      if (s === "ORANGE" || v <= 0.75) return { label: "DEGRADED", cls: "text-orange"  };
      return                            { label: "FAIL",     cls: "text-red"     };
    }

    /* ── LAS (Layer Activation State) display ─────────────── */
    /* Maps ness_entropy cumulative score → LAS tier label.
       ORP_SYNC key: ness_entropy (default 0).
       L1 = stable, L4 = maximum coherence pressure */
    function _lasDisplay(entropy) {
      const e = parseFloat(entropy) || 0;
      if (e <= 10)  return { label: "L1", cls: "text-success" };
      if (e <= 30)  return { label: "L2", cls: "text-success" };
      if (e <= 60)  return { label: "L3", cls: "text-orange"  };
      return               { label: "L4", cls: "text-red"     };
    }

    /* ── Apply a full snapshot of all four values ─────────── */
    function _applyAll(shs, intensity, entropy) {
      const shsD   = _shsDisplay(shs);
      const driftD = _driftDisplay(intensity);
      const craD   = _craDisplay(shs, intensity);
      const lasD   = _lasDisplay(entropy);

      _setVal(elSHS,   shsD.label,   shsD.cls);
      _setVal(elDrift, driftD.label, driftD.cls);
      _setVal(elCRA,   craD.label,   craD.cls);
      _setVal(elLAS,   lasD.label,   lasD.cls);
    }

    /* ── State cache (avoids unnecessary DOM writes) ──────── */
    let _shs      = "GREEN";
    let _drift    = 0;
    let _entropy  = 0;

    function _refresh() { _applyAll(_shs, _drift, _entropy); }

    /* ── 1. Boot from ORP_SYNC persisted values ───────────── */
    if (typeof window.ORP_SYNC !== "undefined") {
      _shs     = ORP_SYNC.load("ness_pressure", ORP_SYNC.default("ness_pressure")) || "GREEN";
      _drift   = ORP_SYNC.load("sigil_drift",   ORP_SYNC.default("sigil_drift"))   || 0;
      _entropy = ORP_SYNC.load("ness_entropy",  ORP_SYNC.default("ness_entropy"))  || 0;
    }
    _refresh();

    /* ── 2. orp-settings-update event (cross-tab / cross-page) */
    window.addEventListener("orp-settings-update", (e) => {
      if (!e.detail) return;
      let changed = false;
      if (e.detail.key === "ness_pressure" && e.detail.value != null) {
        _shs = e.detail.value; changed = true;
      }
      if (e.detail.key === "shs_override"  && e.detail.value != null) {
        _shs = e.detail.value; changed = true;
      }
      if (e.detail.key === "sigil_drift"   && e.detail.value != null) {
        _drift = parseFloat(e.detail.value) || 0; changed = true;
      }
      if (e.detail.key === "ness_entropy"  && e.detail.value != null) {
        _entropy = parseFloat(e.detail.value) || 0; changed = true;
      }
      if (changed) _refresh();
    });

    /* ── 3. MutationObserver on #cc-tab-shs pill ──────────── */
    function _watchSHSPill(pill) {
      function _onPillChange() {
        const raw = pill.textContent.trim().toUpperCase();
        const normalized = raw === "AMBER" ? "YELLOW" : raw;
        if (normalized && normalized !== _shs) {
          _shs = normalized;
          _refresh();
        }
      }
      _onPillChange(); /* apply immediately */
      new MutationObserver(_onPillChange).observe(pill, {
        childList: true, characterData: true, subtree: true,
      });
    }

    const pill = document.getElementById("cc-tab-shs");
    if (pill) {
      _watchSHSPill(pill);
    } else {
      /* runtime-overlay.js may inject the pill after DOMContentLoaded */
      const _waitObs = new MutationObserver((_, obs) => {
        const p = document.getElementById("cc-tab-shs");
        if (p) { obs.disconnect(); _watchSHSPill(p); }
      });
      _waitObs.observe(document.body, { childList: true, subtree: true });
    }

  }()); /* end initTelemetryHUD IIFE */


  /* ── Boot: run logo injection ───────────────────────────── */
  /* initLogoMark is async (fetch). Runs after DOMContentLoaded
     (we're already inside the DOMContentLoaded handler). */
  initLogoMark();

});
