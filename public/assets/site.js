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

  /* ── Facebook quick sign-in ────────────────────────────── */
  /* When a visitor lands with an existing Facebook session on their
     browser, invite them to continue with Facebook and share their email.
     The email is stored securely in our database, for business purposes
     only — the popup says exactly that before they agree. */

  var FB_STORAGE_KEY = "aag_fb_v1";
  var FB_DISMISS_COOLDOWN_MS = 1000 * 60 * 60 * 24 * 5;
  var fbPromptActive = false;

  function getFbState() {
    try {
      return JSON.parse(localStorage.getItem(FB_STORAGE_KEY) || "null") || {};
    } catch (e) {
      return {};
    }
  }

  function setFbState(patch) {
    var next = Object.assign(getFbState(), patch);
    try {
      localStorage.setItem(FB_STORAGE_KEY, JSON.stringify(next));
    } catch (e) {}
    return next;
  }

  function shouldOfferFacebook() {
    var state = getFbState();
    if (state.linked) return false;
    if (state.dismissedAt && Date.now() - state.dismissedAt < FB_DISMISS_COOLDOWN_MS) {
      return false;
    }
    return true;
  }

  async function exchangeFacebookToken(accessToken) {
    var res = await fetch("/auth/facebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: accessToken }),
    });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok || !data || !data.success) {
      throw new Error((data && data.error) || "Could not verify your Facebook session.");
    }
    return data;
  }

  function buildFacebookPrompt(needsEmailRerequest) {
    var backdrop = document.createElement("div");
    backdrop.className = "news-popup-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "fb-popup-title");
    backdrop.innerHTML =
      '<div class="news-popup">' +
      '  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.75rem">' +
      '    <span class="eyebrow">Welcome back</span>' +
      '    <button type="button" data-fb-close aria-label="Close"' +
      '      style="background:none;border:0;color:rgba(255,246,228,0.45);cursor:pointer;font-size:1.1rem;line-height:1;padding:0.25rem;border-radius:0.5rem">&#10005;</button>' +
      "  </div>" +
      '  <h2 id="fb-popup-title" class="headline" style="margin:0.9rem 0 0;font-size:1.55rem;font-weight:650;color:var(--cream)">' +
      (needsEmailRerequest ? "One more thing — your email" : "Continue with Facebook?") +
      "</h2>" +
      '  <p style="margin:0.7rem 0 0;font-size:0.875rem;line-height:1.65;color:rgba(255,246,228,0.6)">' +
      (needsEmailRerequest
        ? "You’re connected with Facebook, but we still need your email to keep you updated. "
        : "It looks like you’re signed in to Facebook. Continue in one tap — we’ll just ask you to share your email. ") +
      "</p>" +
      '  <p style="margin:0.7rem 0 0;font-size:0.78rem;line-height:1.6;color:rgba(240,196,92,0.75)">' +
      "    Your email is stored securely in our database and used for business purposes only — like updates about your graphics. We never post to your Facebook." +
      "  </p>" +
      '  <button type="button" data-fb-continue class="btn-primary" style="width:100%;margin-top:1.3rem;background:linear-gradient(120deg,#4a7dff,#1877f2 55%,#0f5fd7);color:#fff;box-shadow:0 10px 30px rgba(24,119,242,0.35)">' +
      '    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.52 1.5-3.91 3.78-3.91 1.09 0 2.24.2 2.24.2v2.47h-1.26c-1.24 0-1.63.78-1.63 1.57v1.88h2.78l-.45 2.9h-2.33V22c4.78-.75 8.43-4.92 8.43-9.94z"/></svg>' +
      "    Continue with Facebook" +
      "  </button>" +
      '  <p data-fb-note aria-live="polite" style="margin:0.7rem 0 0;min-height:1.1rem;font-size:0.78rem;color:rgba(255,246,228,0.5)"></p>' +
      '  <button type="button" data-fb-close' +
      '    style="display:block;width:100%;margin-top:0.2rem;background:none;border:0;color:rgba(255,246,228,0.4);cursor:pointer;font-size:0.78rem;padding:0.5rem;font-family:inherit">' +
      "    No thanks" +
      "  </button>" +
      "</div>";
    return backdrop;
  }

  function showFacebookPrompt(options) {
    var needsEmailRerequest = Boolean(options && options.rerequest);
    var backdrop = buildFacebookPrompt(needsEmailRerequest);
    document.body.appendChild(backdrop);
    fbPromptActive = true;

    var note = backdrop.querySelector("[data-fb-note]");
    var continueBtn = backdrop.querySelector("[data-fb-continue]");

    function close(dismissed) {
      if (dismissed) setFbState({ dismissedAt: Date.now() });
      fbPromptActive = false;
      backdrop.classList.remove("show");
      setTimeout(function () { backdrop.remove(); }, 500);
    }

    backdrop.querySelectorAll("[data-fb-close]").forEach(function (btn) {
      btn.addEventListener("click", function () { close(true); });
    });
    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) close(true);
    });

    continueBtn.addEventListener("click", function () {
      note.textContent = "";
      continueBtn.disabled = true;
      window.FB.login(
        function (response) {
          if (!response.authResponse) {
            continueBtn.disabled = false;
            note.textContent = "No worries — nothing was shared.";
            return;
          }
          exchangeFacebookToken(response.authResponse.accessToken)
            .then(function (data) {
              if (data.needs_email) {
                continueBtn.disabled = false;
                note.style.color = "rgba(251,191,36,0.9)";
                note.textContent =
                  "We still need your email — tap continue and allow the email permission.";
                return;
              }
              setFbState({ linked: true });
              note.style.color = "rgba(110,231,183,0.95)";
              note.textContent =
                data.message ||
                "Thanks! Your email is stored securely, for business purposes only.";
              setTimeout(function () { close(false); }, 2200);
            })
            .catch(function (err) {
              continueBtn.disabled = false;
              note.style.color = "rgba(251,113,133,0.9)";
              note.textContent = err.message;
            });
        },
        {
          scope: "email",
          auth_type: needsEmailRerequest ? "rerequest" : undefined,
        }
      );
    });

    requestAnimationFrame(function () {
      backdrop.classList.add("show");
    });
  }

  function loadFacebookSdk(appId) {
    return new Promise(function (resolve) {
      window.fbAsyncInit = function () {
        window.FB.init({
          appId: appId,
          cookie: true,
          xfbml: false,
          version: "v21.0",
        });
        resolve(window.FB);
      };
      var script = document.createElement("script");
      script.src = "https://connect.facebook.net/en_US/sdk.js";
      script.async = true;
      script.defer = true;
      script.crossOrigin = "anonymous";
      document.head.appendChild(script);
    });
  }

  async function initFacebook() {
    if (document.body.hasAttribute("data-no-popup")) return;
    if (!shouldOfferFacebook()) return;

    var config = null;
    try {
      var res = await fetch("/auth/facebook/config", { cache: "no-store" });
      config = await res.json();
    } catch (e) {
      return;
    }
    if (!config || !config.enabled || !config.app_id) return;

    var FB;
    try {
      FB = await loadFacebookSdk(config.app_id);
    } catch (e) {
      return;
    }

    FB.getLoginStatus(function (response) {
      if (response.status === "connected" && response.authResponse) {
        // Already authorized our app before — refresh their record quietly.
        exchangeFacebookToken(response.authResponse.accessToken)
          .then(function (data) {
            if (data.needs_email) {
              showFacebookPrompt({ rerequest: true });
            } else {
              setFbState({ linked: true });
            }
          })
          .catch(function () {});
      } else if (response.status === "not_authorized") {
        // Signed in to Facebook on this browser, but hasn't connected with us.
        showFacebookPrompt({ rerequest: false });
      }
      // "unknown": no detectable Facebook session — stay quiet.
    }, true);
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
      // Never stack on top of the Facebook prompt.
      if (shouldShowPopup() && !fbPromptActive) backdrop.classList.add("show");
    }, POPUP_DELAY_MS);
  }

  /* ── Boot ──────────────────────────────────────────────── */
  function boot() {
    initReveal();
    initMobileMenu();
    initPopup();
    bindNewsletterForms();
    initFacebook();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
