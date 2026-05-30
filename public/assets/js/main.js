/* ============================================================
   ORP v3.0 — Shared JS
   GPU-optimized: all scroll-driven DOM writes batched into a
   single requestAnimationFrame callback per frame. The scroll
   event only captures the latest scroll position (a cheap
   read); the rAF callback does all writes, running at most
   once per display refresh cycle regardless of scroll speed.
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

    const scrollMax = document.documentElement.scrollHeight - window.innerHeight;

    if (progressEl && scrollMax > 0) {
      progressEl.style.width = ((_scrollY / scrollMax) * 100) + "%";
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

  /* ── Active nav link helper — shared by desktop + mobile ─
     Extracted once so the string comparison runs in one place
     and both link sets are marked in a single pass.
  ───────────────────────────────────────────────────────── */
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
      _markActiveLink(link);  // reuse shared helper — no duplicated comparison
      link.addEventListener("click", () => {
        mobileNav.classList.remove("active");
        navElement?.classList.remove("menu-open");
        hamburgerBtn.classList.remove("active");
        hamburgerBtn.setAttribute("aria-expanded", "false");
        document.body.style.overflow = "";
      });
    });

    /* Resize: rAF-guarded so rapid resize events don't thrash layout.
       Defined once outside the resize listener — no closure re-creation
       on each event. */
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
    window.addEventListener("resize", _onResize);
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

      const isHidden = extendedContainer.style.display === "none";
      extendedContainer.style.display = isHidden ? "block" : "none";
      consoleToggleBtn.setAttribute("aria-expanded", isHidden ? "true" : "false");
      btnText.textContent  = isHidden
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

      const isHidden = panel.style.display === "none";
      panel.style.display = isHidden ? "block" : "none";
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
      }
    });
  }, { threshold: 0.05 });

  document.querySelectorAll(
    "section, header, .pipeline-card, .doc-card, .principle, .quick-access-card, .release-card"
  ).forEach(el => {
    el.classList.add("reveal");
    observer.observe(el);
  });

});
