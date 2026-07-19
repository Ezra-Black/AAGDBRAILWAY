/* Audrey's Angel Graphics — site-user authentication widget.

   Include on every page (after site.css). It:
     • checks the session (GET /api/auth/me) once per page load,
     • injects Login / Profile / Logout controls into the header nav
       (desktop pill + mobile drawer),
     • provides a login/register modal, and
     • exposes window.AAGAuth so pages can gate actions behind an account
       and seamlessly continue them after login:

         const user = await AAGAuth.requireAuth({
           title: "Log in to send your request",
           message: "…so we can track it for you.",
         });                       // resolves after login/register
                                   // rejects if the visitor closes the modal

   Auth is cookie-based (httpOnly session cookie set by the server), so
   every fetch here uses same-origin credentials — no tokens in JS. */

(function () {
  "use strict";

  var currentUser = null;
  var readyResolve;
  var readyPromise = new Promise(function (resolve) { readyResolve = resolve; });

  /* ── API helpers ───────────────────────────────────────── */

  async function api(path, options) {
    var opts = Object.assign({ credentials: "same-origin" }, options || {});
    if (opts.body && typeof opts.body === "object" && !(opts.body instanceof FormData)) {
      opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers);
      opts.body = JSON.stringify(opts.body);
    }
    var res = await fetch(path, opts);
    var data = null;
    try { data = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, data: data };
  }

  function errorText(result, fallback) {
    var data = result && result.data;
    if (data && data.details) {
      return Object.values(data.details).flat().join(" ");
    }
    return (data && data.error) || fallback || "Something went wrong. Please try again.";
  }

  async function refreshSession() {
    try {
      var result = await api("/api/auth/me");
      currentUser = result.ok && result.data && result.data.success ? result.data.user : null;
    } catch (e) {
      currentUser = null;
    }
    renderNav();
    document.dispatchEvent(new CustomEvent("aag:auth", { detail: { user: currentUser } }));
    return currentUser;
  }

  async function logout() {
    try { await api("/api/auth/logout", { method: "POST" }); } catch (e) {}
    currentUser = null;
    renderNav();
    document.dispatchEvent(new CustomEvent("aag:auth", { detail: { user: null } }));
    // Profile portal is account-only — bounce home after logging out there.
    if (location.pathname === "/profile") location.href = "/";
  }

  /* ── Header nav controls ───────────────────────────────── */

  function initialsFor(user) {
    var source = (user && (user.name || user.email)) || "?";
    var parts = source.trim().split(/\s+/);
    var initials = parts[0].charAt(0) + (parts[1] ? parts[1].charAt(0) : "");
    return initials.toUpperCase();
  }

  function avatarHtml(user, size) {
    var px = size || 30;
    if (user.profile_photo_url) {
      return (
        '<img src="' + user.profile_photo_url + '" alt="" ' +
        'style="width:' + px + 'px;height:' + px + 'px;border-radius:9999px;object-fit:cover;border:1px solid rgba(240,196,92,0.5)" />'
      );
    }
    return (
      '<span style="display:inline-flex;align-items:center;justify-content:center;width:' + px + "px;height:" + px + 'px;border-radius:9999px;background:rgba(240,196,92,0.16);border:1px solid rgba(240,196,92,0.45);color:var(--gold);font-size:' + Math.round(px * 0.38) + 'px;font-weight:700">' +
      initialsFor(user) +
      "</span>"
    );
  }

  function renderNav() {
    var desktop = document.querySelector("header nav .sm\\:flex");
    var mobile = document.querySelector("#mobile-menu .flex");

    [desktop, mobile].forEach(function (container) {
      if (!container) return;
      var isMobile = container.closest("#mobile-menu") !== null;

      var slot = container.querySelector("[data-auth-slot]");
      if (!slot) {
        slot = document.createElement("div");
        slot.setAttribute("data-auth-slot", "");
        slot.style.display = "flex";
        slot.style.alignItems = "center";
        slot.style.gap = "0.6rem";
        if (isMobile) {
          slot.style.flexDirection = "column";
          slot.style.alignItems = "stretch";
          slot.style.borderTop = "1px solid rgba(255,255,255,0.08)";
          slot.style.paddingTop = "0.9rem";
          container.appendChild(slot);
        } else {
          // Keep "Request yours" as the last CTA; auth sits just before it.
          var cta = container.querySelector(".nav-cta");
          container.insertBefore(slot, cta || null);
        }
      }

      if (currentUser) {
        slot.innerHTML = isMobile
          ? '<a href="/profile" class="nav-auth-profile" style="justify-content:flex-start">' +
            avatarHtml(currentUser, 28) +
            '<span>My profile</span></a>' +
            '<button type="button" data-auth-logout class="nav-auth-btn" style="width:100%">Log out</button>'
          : '<a href="/profile" class="nav-auth-profile" title="My profile">' +
            avatarHtml(currentUser, 30) +
            "</a>" +
            '<button type="button" data-auth-logout class="nav-auth-btn">Log out</button>';
      } else {
        slot.innerHTML =
          '<button type="button" data-auth-login class="nav-auth-btn' +
          (isMobile ? '" style="width:100%' : "") +
          '">Log in</button>';
      }
    });

    document.querySelectorAll("[data-auth-login]").forEach(function (btn) {
      btn.addEventListener("click", function () { openModal(); });
    });
    document.querySelectorAll("[data-auth-logout]").forEach(function (btn) {
      btn.addEventListener("click", function () { logout(); });
    });
  }

  /* ── Login / register modal ────────────────────────────── */

  var activeModal = null;

  function fieldHtml(id, label, type, placeholder, autocomplete, hint) {
    return (
      '<div class="field" style="margin-top:0.85rem">' +
      '<label for="' + id + '">' + label + "</label>" +
      '<input id="' + id + '" type="' + type + '" placeholder="' + placeholder + '" autocomplete="' + (autocomplete || "off") + '" maxlength="254" />' +
      (hint ? '<p style="margin:0.35rem 0 0;font-size:0.72rem;color:rgba(255,246,228,0.4)">' + hint + "</p>" : "") +
      "</div>"
    );
  }

  function buildModal(options) {
    var backdrop = document.createElement("div");
    backdrop.className = "news-popup-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "auth-modal-title");

    var title = (options && options.title) || "Welcome back";
    var message =
      (options && options.message) ||
      "Log in to track your requests and orders, or create a free account in seconds.";

    backdrop.innerHTML =
      '<div class="news-popup" style="max-width:27rem">' +
      '  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.75rem">' +
      '    <span class="eyebrow">Your account</span>' +
      '    <button type="button" data-auth-close aria-label="Close"' +
      '      style="background:none;border:0;color:rgba(255,246,228,0.45);cursor:pointer;font-size:1.1rem;line-height:1;padding:0.25rem;border-radius:0.5rem">&#10005;</button>' +
      "  </div>" +
      '  <h2 id="auth-modal-title" class="headline" style="margin:0.9rem 0 0;font-size:1.5rem;font-weight:650;color:var(--cream)">' + title + "</h2>" +
      '  <p data-auth-message style="margin:0.6rem 0 0;font-size:0.85rem;line-height:1.6;color:rgba(255,246,228,0.6)">' + message + "</p>" +
      '  <div class="auth-tabs" style="display:flex;gap:0.4rem;margin-top:1.2rem">' +
      '    <button type="button" data-auth-tab="login" class="auth-tab active">Log in</button>' +
      '    <button type="button" data-auth-tab="register" class="auth-tab">Create account</button>' +
      "  </div>" +

      // Login pane
      '  <form data-auth-pane="login" style="margin-top:0.4rem">' +
      fieldHtml("auth-login-email", "Email", "email", "you@email.com", "email") +
      fieldHtml("auth-login-password", "Password", "password", "Your password", "current-password") +
      '    <button type="submit" class="btn-primary" style="width:100%;margin-top:1.1rem">Log in</button>' +
      '    <button type="button" data-auth-forgot style="display:block;width:100%;margin-top:0.4rem;background:none;border:0;color:rgba(240,196,92,0.75);cursor:pointer;font-size:0.78rem;padding:0.45rem;font-family:inherit">Forgot your password?</button>' +
      "  </form>" +

      // Register pane
      '  <form data-auth-pane="register" style="display:none;margin-top:0.4rem">' +
      fieldHtml("auth-reg-name", "Your name", "text", "Who you are IRL", "name") +
      fieldHtml("auth-reg-angel", "Angel’s name (optional)", "text", "Your loved one’s name for graphics", "off",
        "The name of your deceased loved one, used on their graphics. You can add or change it later.") +
      fieldHtml("auth-reg-email", "Email", "email", "you@email.com", "email") +
      fieldHtml("auth-reg-password", "Password", "password", "10+ chars, mixed case, number, symbol", "new-password",
        "At least 10 characters with upper &amp; lower case, a number, and a special character.") +
      '    <button type="submit" class="btn-primary" style="width:100%;margin-top:1.1rem">Create my account</button>' +
      "  </form>" +

      // Forgot-password pane
      '  <form data-auth-pane="forgot" style="display:none;margin-top:0.4rem">' +
      '    <p style="margin:0.8rem 0 0;font-size:0.82rem;line-height:1.6;color:rgba(255,246,228,0.6)">Enter your email and we’ll send you a link to choose a new password.</p>' +
      fieldHtml("auth-forgot-email", "Email", "email", "you@email.com", "email") +
      '    <button type="submit" class="btn-primary" style="width:100%;margin-top:1.1rem">Email me a reset link</button>' +
      '    <button type="button" data-auth-back style="display:block;width:100%;margin-top:0.4rem;background:none;border:0;color:rgba(255,246,228,0.45);cursor:pointer;font-size:0.78rem;padding:0.45rem;font-family:inherit">← Back to log in</button>' +
      "  </form>" +

      '  <p data-auth-note aria-live="polite" style="margin:0.8rem 0 0;min-height:1.1rem;font-size:0.78rem;color:rgba(255,246,228,0.5)"></p>' +
      "</div>";
    return backdrop;
  }

  /**
   * Open the login/register modal.
   * Returns a Promise that resolves with the user after a successful
   * login/registration, or rejects if the visitor dismisses the modal.
   */
  function openModal(options) {
    if (activeModal) return activeModal.promise;

    var backdrop = buildModal(options);
    document.body.appendChild(backdrop);

    var note = backdrop.querySelector("[data-auth-note]");
    var resolvePromise, rejectPromise;
    var promise = new Promise(function (resolve, reject) {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    activeModal = { el: backdrop, promise: promise };

    function setNote(text, ok) {
      note.textContent = text || "";
      note.style.color = ok ? "rgba(110,231,183,0.95)" : "rgba(251,113,133,0.9)";
    }

    function showPane(name) {
      backdrop.querySelectorAll("[data-auth-pane]").forEach(function (pane) {
        pane.style.display = pane.getAttribute("data-auth-pane") === name ? "block" : "none";
      });
      backdrop.querySelectorAll("[data-auth-tab]").forEach(function (tab) {
        tab.classList.toggle("active", tab.getAttribute("data-auth-tab") === name);
      });
      setNote("");
    }

    function close(succeeded, user) {
      activeModal = null;
      backdrop.classList.remove("show");
      setTimeout(function () { backdrop.remove(); }, 450);
      document.removeEventListener("keydown", onKey);
      if (succeeded) resolvePromise(user);
      else rejectPromise(new Error("auth_dismissed"));
    }

    function onKey(e) {
      if (e.key === "Escape") close(false);
    }
    document.addEventListener("keydown", onKey);

    backdrop.querySelector("[data-auth-close]").addEventListener("click", function () { close(false); });
    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) close(false);
    });

    backdrop.querySelectorAll("[data-auth-tab]").forEach(function (tab) {
      tab.addEventListener("click", function () { showPane(tab.getAttribute("data-auth-tab")); });
    });
    backdrop.querySelector("[data-auth-forgot]").addEventListener("click", function () { showPane("forgot"); });
    backdrop.querySelector("[data-auth-back]").addEventListener("click", function () { showPane("login"); });

    function busy(form, isBusy, label) {
      var btn = form.querySelector("button[type='submit']");
      btn.disabled = isBusy;
      if (isBusy) { btn.dataset.label = btn.textContent; btn.textContent = label; }
      else if (btn.dataset.label) { btn.textContent = btn.dataset.label; }
    }

    async function finishAuth(user, message) {
      currentUser = user;
      renderNav();
      document.dispatchEvent(new CustomEvent("aag:auth", { detail: { user: user } }));
      setNote(message || "You’re in!", true);
      setTimeout(function () { close(true, user); }, 700);
    }

    // Log in
    backdrop.querySelector("[data-auth-pane='login']").addEventListener("submit", async function (e) {
      e.preventDefault();
      var form = e.currentTarget;
      setNote("");
      busy(form, true, "Logging in…");
      try {
        var result = await api("/api/auth/login", {
          method: "POST",
          body: {
            email: backdrop.querySelector("#auth-login-email").value.trim(),
            password: backdrop.querySelector("#auth-login-password").value,
          },
        });
        if (!result.ok || !result.data || !result.data.success) {
          setNote(errorText(result, "Invalid email or password."));
          return;
        }
        await finishAuth(result.data.user, "Welcome back!");
      } catch (err) {
        setNote("Network glitch. Try again in a sec.");
      } finally {
        busy(form, false);
      }
    });

    // Register
    backdrop.querySelector("[data-auth-pane='register']").addEventListener("submit", async function (e) {
      e.preventDefault();
      var form = e.currentTarget;
      setNote("");
      busy(form, true, "Creating…");
      try {
        var body = {
          name: backdrop.querySelector("#auth-reg-name").value.trim(),
          email: backdrop.querySelector("#auth-reg-email").value.trim(),
          password: backdrop.querySelector("#auth-reg-password").value,
        };
        var angel = backdrop.querySelector("#auth-reg-angel").value.trim();
        if (angel) body.angel_name = angel;

        var result = await api("/api/auth/register", { method: "POST", body: body });
        if (!result.ok || !result.data || !result.data.success) {
          setNote(errorText(result, "Could not create your account."));
          return;
        }
        await finishAuth(result.data.user, "Account created — welcome!");
      } catch (err) {
        setNote("Network glitch. Try again in a sec.");
      } finally {
        busy(form, false);
      }
    });

    // Forgot password
    backdrop.querySelector("[data-auth-pane='forgot']").addEventListener("submit", async function (e) {
      e.preventDefault();
      var form = e.currentTarget;
      setNote("");
      busy(form, true, "Sending…");
      try {
        var result = await api("/api/auth/forgot-password", {
          method: "POST",
          body: { email: backdrop.querySelector("#auth-forgot-email").value.trim() },
        });
        if (!result.ok || !result.data || !result.data.success) {
          setNote(errorText(result, "Could not send the reset email."));
          return;
        }
        setNote(result.data.message, true);
      } catch (err) {
        setNote("Network glitch. Try again in a sec.");
      } finally {
        busy(form, false);
      }
    });

    requestAnimationFrame(function () { backdrop.classList.add("show"); });
    return promise;
  }

  /**
   * Gate an action behind an account. Resolves immediately with the user
   * when already logged in; otherwise opens the modal and resolves after a
   * successful login/register so the caller can continue the interrupted
   * action. Rejects when the visitor dismisses the modal.
   */
  async function requireAuth(options) {
    await readyPromise;
    if (currentUser) return currentUser;
    return openModal(options);
  }

  /* ── Boot ──────────────────────────────────────────────── */

  function boot() {
    refreshSession().then(function () { readyResolve(currentUser); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.AAGAuth = {
    ready: readyPromise,
    getUser: function () { return currentUser; },
    requireAuth: requireAuth,
    openModal: openModal,
    logout: logout,
    refresh: refreshSession,
  };
})();
