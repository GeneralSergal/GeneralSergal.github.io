/* ============================================================
   ORP v3.0 — Shared JS
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {

  /* ── Scroll progress bar ─────────────────────────────── */
  window.addEventListener("scroll", () => {
    const scrolled =
      (window.scrollY /
        (document.documentElement.scrollHeight - window.innerHeight)) * 100;

    const progressEl = document.querySelector(".scroll-progress");

    if (progressEl) {
      progressEl.style.width = scrolled + "%";
    }
  });

  /* ── Scroll to top ───────────────────────────────────── */
  const topBtn = document.getElementById("scroll-top-btn");

  if (topBtn) {

    window.addEventListener("scroll", () => {
      topBtn.classList.toggle("visible", window.scrollY > 400);
    });

    topBtn.addEventListener("click", () => {
      window.scrollTo({
        top: 0,
        behavior: "smooth"
      });
    });
  }

  /* ── Mobile navbar hide/reveal ───────────────────────── */
  let lastScrollY = window.scrollY;

  const navElement = document.getElementById("main-nav");

  const scrollThreshold = 8;

  window.addEventListener("scroll", () => {

    if (window.innerWidth <= 640) {

      const currentScrollY = window.scrollY;

      const delta = currentScrollY - lastScrollY;

      if (currentScrollY <= 0) {

        navElement.classList.remove("nav-hidden");

        lastScrollY = currentScrollY;

        return;
      }

      if (Math.abs(delta) > scrollThreshold) {

        navElement.classList.toggle(
          "nav-hidden",
          delta > 0
        );

        lastScrollY = currentScrollY;
      }

    } else {

      navElement.classList.remove("nav-hidden");
    }

  }, { passive: true });

  /* ── Active nav link (multi-page) ───────────────────── */
  const currentPage =
    window.location.pathname.split("/").pop() || "index.html";

  document.querySelectorAll(".nav-links a").forEach(link => {

    const href =
      link.getAttribute("href").split("/").pop();

    if (
      href === currentPage ||
      (currentPage === "" && href === "index.html")
    ) {
      link.classList.add("active");
    }
  });

/* ── Mobile hamburger navigation ───────────────────── */

const hamburgerBtn =
  document.getElementById("hamburger-btn");

const mobileNav =
  document.getElementById("mobile-nav");

if (hamburgerBtn && mobileNav) {

  const toggleMenu = () => {

    const isActive =
      mobileNav.classList.toggle("active");

    hamburgerBtn.classList.toggle(
      "active",
      isActive
    );

    hamburgerBtn.setAttribute(
      "aria-expanded",
      isActive ? "true" : "false"
    );

    document.body.style.overflow =
      isActive ? "hidden" : "";

    navElement.classList.toggle(
      "menu-open",
      isActive
    );
  };

  hamburgerBtn.addEventListener(
    "click",
    toggleMenu
  );

  mobileNav.querySelectorAll("a").forEach(link => {

    const href =
      link.getAttribute("href").split("/").pop();

    if (
      href === currentPage ||
      (currentPage === "" && href === "index.html")
    ) {
      link.classList.add("active");
    }

    link.addEventListener("click", () => {

      mobileNav.classList.remove("active");

      navElement.classList.remove("menu-open");

      hamburgerBtn.classList.remove("active");

      hamburgerBtn.setAttribute(
        "aria-expanded",
        "false"
      );

      document.body.style.overflow = "";
    });

  });

  window.addEventListener("resize", () => {

    if (window.innerWidth > 640) {

      mobileNav.classList.remove("active");

      navElement.classList.remove("menu-open");

      hamburgerBtn.classList.remove("active");

      document.body.style.overflow = "";
    }
  });
}
  /* ── Author image fallback ───────────────────────────── */
  const authorImg =
    document.getElementById("author-img");

  const avatarContainer =
    document.getElementById("avatar-container");

  if (authorImg && avatarContainer) {

    authorImg.addEventListener("error", () => {
      avatarContainer.classList.add("img-error");
    });

    if (authorImg.naturalWidth === 0) {
      avatarContainer.classList.add("img-error");
    }
  }

  /* ── Telemetry console toggle ────────────────────────── */
  const consoleToggleBtn =
    document.getElementById("console-toggle-btn");

  if (consoleToggleBtn) {

    consoleToggleBtn.addEventListener("click", () => {

      const extendedContainer =
        document.getElementById(
          "extended-telemetry-container"
        );

      const btnText =
        document.getElementById(
          "telemetry-btn-text"
        );

      if (!extendedContainer || !btnText) {
        return;
      }

      const isHidden =
        extendedContainer.style.display === "none";

      extendedContainer.style.display =
        isHidden ? "block" : "none";

      consoleToggleBtn.setAttribute(
        "aria-expanded",
        isHidden ? "true" : "false"
      );

      btnText.innerText =
        isHidden
          ? "[ COLLAPSE SYSTEM ARTIFACTS - ]"
          : "[ EXPAND SYSTEM ARTIFACTS + ]";

      btnText.style.color =
        isHidden
          ? "var(--accent-orange)"
          : "var(--muted)";
    });
  }

  /* ── Variant matrix toggle ───────────────────────────── */
  const variantToggleBtn =
    document.getElementById("variant-toggle-btn");

  if (variantToggleBtn) {

    variantToggleBtn.addEventListener("click", () => {

      const panel =
        document.getElementById(
          "variant-matrix-panel"
        );

      const btnSpan =
        variantToggleBtn.querySelector("span");

      if (!panel || !btnSpan) {
        return;
      }

      const isHidden =
        panel.style.display === "none";

      panel.style.display =
        isHidden ? "block" : "none";

      variantToggleBtn.setAttribute(
        "aria-expanded",
        isHidden ? "true" : "false"
      );

      btnSpan.innerText =
        isHidden
          ? "[SYSTEM // CLOSE VARIANT MATRIX]"
          : "[SYSTEM // EXECUTE VARIANT MATRIX]";
    });
  }

  /* ── Intersection Observer reveal ───────────────────── */
  const observer =
    new IntersectionObserver(entries => {

      entries.forEach(entry => {

        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
        }
      });

    }, {
      threshold: 0.05
    });

  document.querySelectorAll(
    "section, header, .pipeline-card, .doc-card, .principle, .quick-access-card, .release-card"
  ).forEach(el => {

    el.classList.add("reveal");

    observer.observe(el);
  });

});