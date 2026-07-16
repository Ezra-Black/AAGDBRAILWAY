/* Audrey's Angel Graphics — shared page behaviors
   Scroll reveal, mobile nav, and the mailing-list opt-in popup. */

(function () {
  "use strict";

  /* ── Scroll reveal ─────────────────────────────────────── */
  function initReveal() {
    var items = document.querySelectorAll(".reveal");
    if (!("IntersectionObserver" in window)) {
      items.forEach(function (el) { el.classList.add("is-visible"); });
      return;
    }
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    items.forEach(function (el) { observer.observe(el); });
  }

  /* ── Mobile menu ───────────────────────────────────────── */
  function initMobileMenu() {
    var toggle = document.getElementById("menu-toggle");
    var menu = document.getElementById("mobile-menu");
    if (!toggle || !menu) return;
    toggle.addEventListener("click", function () {
      var open = menu.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  /* ── Newsletter subscribe helper ───────────────────────── */
  var STORAGE_KEY = "aag_mailing_list_v1";

  function getState() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || {};
    } catch (e) {
      return {};
    }
  }

  function setState(patch) {
    var next = Object.assign(getState(), patch);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (e) {}
    return next;
  }

  async function subscribe(email) {
    var res = await fetch("/newsletter/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email }),
    });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok || !data || !data.success) {
      var detail =
        data && data.details
          ? Object.values(data.details).flat().join(" ")
          : (data && data.error) || "Something went wrong. Try again in a moment.";
      throw new Error(detail);
    }
    setState({ subscribed: true });
    document.dispatchEvent(new CustomEvent("aag:subscribed"));
    return data;
  }

  /** Wire any element with [data-newsletter-form] to the subscribe endpoint. */
  function bindNewsletterForms() {
    document.querySelectorAll("[data-newsletter-form]").forEach(function (form) {
      var input = form.querySelector("input[type='email']");
      var btn = form.querySelector("button[type='submit']");
      var note = form.querySelector("[data-newsletter-note]");

      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        var email = (input.value || "").trim();
        if (!email) {
          if (note) {
            note.textContent = "Enter your email first.";
            note.style.color = "rgba(251,113,133,0.9)";
          }
          return;
        }
        if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = "Joining…"; }
        try {
          var data = await subscribe(email);
          input.value = "";
          if (note) {
            note.textContent = data.message || "You’re in!";
            note.style.color = "rgba(110,231,183,0.95)";
          }
        } catch (err) {
          if (note) {
            note.textContent = err.message;
            note.style.color = "rgba(251,113,133,0.9)";
          }
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || "Join"; }
        }
      });
    });
  }

  /* ── Opt-in popup ──────────────────────────────────────── */
  var POPUP_DELAY_MS = 9000;
  var DISMISS_COOLDOWN_MS = 1000 * 60 * 60 * 24 * 5; // re-invite after 5 days

  function shouldShowPopup() {
    var state = getState();
    if (state.subscribed) return false;
    if (state.dismissedAt && Date.now() - state.dismissedAt < DISMISS_COOLDOWN_MS) {
      return false;
    }
    return true;
  }

  function buildPopup() {
    var backdrop = document.createElement("div");
    backdrop.className = "news-popup-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "news-popup-title");
    backdrop.innerHTML =
      '<div class="news-popup">' +
      '  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.75rem">' +
      '    <span class="eyebrow">Stay in the light</span>' +
      '    <button type="button" data-popup-close aria-label="Close"' +
      '      style="background:none;border:0;color:rgba(255,246,228,0.45);cursor:pointer;font-size:1.1rem;line-height:1;padding:0.25rem;border-radius:0.5rem">&#10005;</button>' +
      "  </div>" +
      '  <h2 id="news-popup-title" class="headline" style="margin:0.9rem 0 0;font-size:1.55rem;font-weight:650;color:var(--cream)">Join the mailing list?</h2>' +
      '  <p style="margin:0.7rem 0 0;font-size:0.875rem;line-height:1.65;color:rgba(255,246,228,0.6)">' +
      "    Be the first to hear when new angel graphics drop, and get a gentle nudge when yours is ready. No spam — just the good stuff." +
      "  </p>" +
      '  <form data-newsletter-form style="margin-top:1.4rem">' +
      '    <div class="field">' +
      '      <input type="email" autocomplete="email" maxlength="254" placeholder="you@email.com" aria-label="Email address" required />' +
      "    </div>" +
      '    <button type="submit" class="btn-primary" style="width:100%;margin-top:0.8rem">Count me in</button>' +
      '    <p data-newsletter-note aria-live="polite" style="margin:0.7rem 0 0;min-height:1.1rem;font-size:0.78rem;color:rgba(255,246,228,0.5)"></p>' +
      "  </form>" +
      '  <button type="button" data-popup-close' +
      '    style="display:block;width:100%;margin-top:0.4rem;background:none;border:0;color:rgba(255,246,228,0.4);cursor:pointer;font-size:0.78rem;padding:0.5rem;font-family:inherit">' +
      "    No thanks, maybe later" +
      "  </button>" +
      "</div>";
    return backdrop;
  }

  function initPopup() {
    if (document.body.hasAttribute("data-no-popup")) return;
    if (!shouldShowPopup()) return;

    var backdrop = buildPopup();
    document.body.appendChild(backdrop);

    function close() {
      setState({ dismissedAt: Date.now() });
      backdrop.classList.remove("show");
      setTimeout(function () { backdrop.remove(); }, 500);
    }

    backdrop.querySelectorAll("[data-popup-close]").forEach(function (btn) {
      btn.addEventListener("click", close);
    });
    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) close();
    });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", onKey);
      }
    });

    // After a successful opt-in, let the thank-you show, then slip away.
    document.addEventListener("aag:subscribed", function () {
      setTimeout(function () {
        backdrop.classList.remove("show");
        setTimeout(function () { backdrop.remove(); }, 500);
      }, 1800);
    });

    setTimeout(function () {
      if (shouldShowPopup()) backdrop.classList.add("show");
    }, POPUP_DELAY_MS);
  }

  /* ── Boot ──────────────────────────────────────────────── */
  function boot() {
    initReveal();
    initMobileMenu();
    initPopup();
    bindNewsletterForms();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
