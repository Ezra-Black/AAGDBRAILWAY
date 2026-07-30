/**
 * Shared “leave a review” modal for shop/form success + the reviews page.
 * Depends on /assets/auth.js (window.AAGAuth).
 */
(function () {
  "use strict";

  let backdrop = null;
  let rating = 0;
  let source = "reviews_page";

  function ensureModal() {
    if (backdrop) return backdrop;

    backdrop = document.createElement("div");
    backdrop.className = "review-modal-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-label", "Leave a review");
    backdrop.innerHTML =
      '<div class="review-modal glass-panel">' +
      '  <button type="button" class="review-modal-close" aria-label="Close">&times;</button>' +
      '  <p class="eyebrow">Share your thoughts</p>' +
      '  <h3 class="headline mt-2 text-2xl font-semibold text-cream">Leave a review</h3>' +
      '  <p class="mt-2 text-sm font-light text-cream/55">A quick note helps other families feel at home here. We read every one before it goes live.</p>' +
      '  <form id="review-modal-form" class="mt-6 space-y-4" novalidate>' +
      '    <div>' +
      '      <label class="block text-xs font-medium uppercase tracking-wider text-cream/45">Rating</label>' +
      '      <div class="review-stars mt-2" role="radiogroup" aria-label="Star rating"></div>' +
      '    </div>' +
      '    <div class="field">' +
      '      <label for="review-display-name">Display name</label>' +
      '      <input id="review-display-name" type="text" maxlength="80" autocomplete="nickname" placeholder="How should we show your name?" />' +
      '    </div>' +
      '    <label class="flex items-center gap-2 text-sm text-cream/70 cursor-pointer">' +
      '      <input id="review-anonymous" type="checkbox" class="rounded border-cream/30" />' +
      '      Post anonymously' +
      "    </label>" +
      '    <div class="field">' +
      '      <label for="review-body">Your review</label>' +
      '      <textarea id="review-body" rows="4" maxlength="500" placeholder="What stood out about your experience?"></textarea>' +
      '      <p class="mt-1 text-right text-[11px] text-cream/35"><span id="review-char-count">0</span>/500</p>' +
      "    </div>" +
      '    <p id="review-modal-status" class="rounded-2xl px-4 py-3 text-sm leading-relaxed" hidden></p>' +
      '    <button type="submit" id="review-modal-submit" class="btn-primary w-full">Submit review</button>' +
      "  </form>" +
      "</div>";

    document.body.appendChild(backdrop);

    const stars = backdrop.querySelector(".review-stars");
    for (let i = 1; i <= 5; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "review-star";
      btn.setAttribute("aria-label", i + " star" + (i === 1 ? "" : "s"));
      btn.dataset.value = String(i);
      btn.textContent = "★";
      btn.addEventListener("click", function () {
        rating = i;
        paintStars();
      });
      stars.appendChild(btn);
    }

    backdrop.querySelector(".review-modal-close").addEventListener("click", close);
    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) close();
    });

    const body = backdrop.querySelector("#review-body");
    const count = backdrop.querySelector("#review-char-count");
    body.addEventListener("input", function () {
      count.textContent = String(body.value.length);
    });

    const anon = backdrop.querySelector("#review-anonymous");
    const nameInput = backdrop.querySelector("#review-display-name");
    anon.addEventListener("change", function () {
      nameInput.disabled = anon.checked;
      if (anon.checked) nameInput.value = "";
    });

    backdrop.querySelector("#review-modal-form").addEventListener("submit", onSubmit);

    return backdrop;
  }

  function paintStars() {
    if (!backdrop) return;
    backdrop.querySelectorAll(".review-star").forEach(function (btn) {
      const v = Number(btn.dataset.value);
      btn.classList.toggle("active", v <= rating);
    });
  }

  function showStatus(text, ok) {
    const el = backdrop.querySelector("#review-modal-status");
    el.hidden = false;
    el.textContent = text;
    el.className =
      "rounded-2xl px-4 py-3 text-sm leading-relaxed " +
      (ok
        ? "border border-emerald-400/40 bg-emerald-500/15 text-emerald-100"
        : "border border-rose-400/40 bg-rose-500/15 text-rose-100");
  }

  function close() {
    if (!backdrop) return;
    backdrop.classList.remove("open");
  }

  async function open(options) {
    ensureModal();
    source = (options && options.source) || "reviews_page";
    rating = 0;
    paintStars();
    const form = backdrop.querySelector("#review-modal-form");
    form.reset();
    backdrop.querySelector("#review-char-count").textContent = "0";
    backdrop.querySelector("#review-display-name").disabled = false;
    backdrop.querySelector("#review-modal-status").hidden = true;
    backdrop.querySelector("#review-modal-submit").disabled = false;
    backdrop.querySelector("#review-modal-submit").textContent = "Submit review";

    try {
      if (!window.AAGAuth) {
        showStatus("Please refresh and try again.", false);
        backdrop.classList.add("open");
        return;
      }
      const user = await window.AAGAuth.requireAuth({
        title: "Sign in to leave a review",
        message: "Create a free account so we can show your review with your profile.",
      });
      const nameInput = backdrop.querySelector("#review-display-name");
      if (user && user.name && !nameInput.value) {
        nameInput.value = user.name.split(/\s+/)[0] || user.name;
      }
    } catch {
      return;
    }

    backdrop.classList.add("open");
  }

  async function onSubmit(e) {
    e.preventDefault();
    const status = backdrop.querySelector("#review-modal-status");
    status.hidden = true;

    if (rating < 1) {
      showStatus("Please pick a star rating.", false);
      return;
    }

    const isAnonymous = backdrop.querySelector("#review-anonymous").checked;
    const displayName = backdrop
      .querySelector("#review-display-name")
      .value.trim();
    const body = backdrop.querySelector("#review-body").value.trim();

    if (!isAnonymous && !displayName) {
      showStatus("Enter a display name, or choose anonymous.", false);
      return;
    }
    if (body.length < 20) {
      showStatus("Please write at least a short sentence (20 characters).", false);
      return;
    }

    const btn = backdrop.querySelector("#review-modal-submit");
    btn.disabled = true;
    btn.textContent = "Sending…";

    try {
      const res = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          rating: rating,
          body: body,
          display_name: displayName,
          is_anonymous: isAnonymous,
          source: source,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        const detail = data.details
          ? Object.values(data.details).flat().join(" ")
          : data.error || "Something went wrong. Try again in a moment.";
        showStatus(detail, false);
        return;
      }
      showStatus(
        data.message || "Thanks — we’ll review it shortly before it goes live.",
        true
      );
      btn.textContent = "Submitted";
      setTimeout(close, 1800);
    } catch {
      showStatus("Network glitch. Try again in a sec.", false);
      btn.disabled = false;
      btn.textContent = "Submit review";
      return;
    } finally {
      if (btn.textContent !== "Submitted") {
        btn.disabled = false;
        btn.textContent = "Submit review";
      }
    }
  }

  window.AAGReviews = {
    open: open,
    close: close,
  };
})();
