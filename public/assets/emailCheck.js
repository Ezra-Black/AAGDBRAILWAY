/* Shared email domain typo checks for public forms.
   Keep DOMAIN_TYPOS in sync with src/emailDomain.ts. */

(function () {
  "use strict";

  var DOMAIN_TYPOS = {
    "sol.com": "aol.com",
    "aoll.com": "aol.com",
    "apl.com": "aol.com",
    "ao.com": "aol.com",
    "aol.co": "aol.com",
    "aol.con": "aol.com",
    "aol.cm": "aol.com",
    "aol.om": "aol.com",
    "gmial.com": "gmail.com",
    "gmal.com": "gmail.com",
    "gamil.com": "gmail.com",
    "gnail.com": "gmail.com",
    "gmai.com": "gmail.com",
    "gmail.co": "gmail.com",
    "gmail.con": "gmail.com",
    "gmail.cm": "gmail.com",
    "gmail.om": "gmail.com",
    "gmail.comm": "gmail.com",
    "gmaill.com": "gmail.com",
    "googlemail.co": "gmail.com",
    "yaho.com": "yahoo.com",
    "yahooo.com": "yahoo.com",
    "yahu.com": "yahoo.com",
    "yahoo.co": "yahoo.com",
    "yahoo.con": "yahoo.com",
    "yahoo.cm": "yahoo.com",
    "yhoo.com": "yahoo.com",
    "hotmial.com": "hotmail.com",
    "hotmal.com": "hotmail.com",
    "hotmail.co": "hotmail.com",
    "hotmail.con": "hotmail.com",
    "hotmail.cm": "hotmail.com",
    "hotmaill.com": "hotmail.com",
    "outlok.com": "outlook.com",
    "outloo.com": "outlook.com",
    "outlook.co": "outlook.com",
    "outlook.con": "outlook.com",
    "outlook.cm": "outlook.com",
    "live.co": "live.com",
    "live.con": "live.com",
    "msn.co": "msn.com",
    "msn.con": "msn.com",
    "iclou.com": "icloud.com",
    "icloud.co": "icloud.com",
    "icloud.con": "icloud.com",
    "icloud.cm": "icloud.com",
    "me.co": "me.com",
    "mac.co": "mac.com",
    "comacast.net": "comcast.net",
    "comast.net": "comcast.net",
    "comcast.con": "comcast.net",
    "verizon.con": "verizon.net",
    "verison.net": "verizon.net",
    "att.con": "att.net",
    "sbcgolbal.net": "sbcglobal.net",
    "sbcglobal.con": "sbcglobal.net",
    "spectrum.con": "spectrum.net",
  };

  var TLD_TYPOS = {
    con: "com",
    cmo: "com",
    ocm: "com",
    comm: "com",
    ent: "net",
    nett: "net",
  };

  function splitEmail(email) {
    var trimmed = String(email || "").trim().toLowerCase();
    var at = trimmed.lastIndexOf("@");
    if (at <= 0 || at === trimmed.length - 1) return null;
    var local = trimmed.slice(0, at);
    var domain = trimmed.slice(at + 1);
    if (!local || !domain || domain.indexOf("@") !== -1) return null;
    return { local: local, domain: domain };
  }

  function suggestEmailCorrection(email) {
    var parts = splitEmail(email);
    if (!parts) return null;

    var suggestedDomain = DOMAIN_TYPOS[parts.domain] || null;
    if (!suggestedDomain) {
      var dot = parts.domain.lastIndexOf(".");
      if (dot > 0) {
        var name = parts.domain.slice(0, dot);
        var tld = parts.domain.slice(dot + 1);
        if (TLD_TYPOS[tld]) suggestedDomain = name + "." + TLD_TYPOS[tld];
      }
    }
    if (!suggestedDomain || suggestedDomain === parts.domain) return null;

    return {
      email: parts.local + "@" + parts.domain,
      domain: parts.domain,
      suggestedDomain: suggestedDomain,
      suggestedEmail: parts.local + "@" + suggestedDomain,
    };
  }

  function isBasicEmailShape(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
  }

  /**
   * Validate an email for form/shop submit.
   * Returns { ok: true } or { ok: false, error, suggestion? }.
   */
  function validateEmail(email) {
    var value = String(email || "").trim();
    if (!value) return { ok: false, error: "Please enter your email." };
    if (!isBasicEmailShape(value)) {
      return { ok: false, error: "Please enter a valid email address." };
    }
    var hint = suggestEmailCorrection(value);
    if (hint) {
      return {
        ok: false,
        error: "That email domain looks off — did you mean " + hint.suggestedEmail + "?",
        suggestion: hint,
      };
    }
    return { ok: true };
  }

  /**
   * Wire an email input + optional hint element for live typo feedback.
   * hintEl can be a <p>; clicking "Use …" applies the suggestion.
   */
  function bindEmailHint(input, hintEl) {
    if (!input || !hintEl) return;

    function clearHint() {
      hintEl.hidden = true;
      hintEl.textContent = "";
      hintEl.onclick = null;
      hintEl.classList.remove("email-hint-action");
      hintEl.removeAttribute("role");
      hintEl.removeAttribute("tabindex");
    }

    function showSuggestion(hint) {
      hintEl.hidden = false;
      hintEl.classList.add("email-hint-action");
      hintEl.setAttribute("role", "button");
      hintEl.setAttribute("tabindex", "0");
      hintEl.textContent =
        "Did you mean " + hint.suggestedEmail + "? Tap to use it.";
      hintEl.onclick = function () {
        input.value = hint.suggestedEmail;
        clearHint();
        input.focus();
      };
      hintEl.onkeydown = function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          hintEl.click();
        }
      };
    }

    function check() {
      var value = input.value.trim();
      if (!value) {
        clearHint();
        return;
      }
      var hint = suggestEmailCorrection(value);
      if (hint) showSuggestion(hint);
      else clearHint();
    }

    input.addEventListener("blur", check);
    input.addEventListener("input", function () {
      if (!hintEl.hidden) check();
    });
  }

  window.AAGEmail = {
    suggest: suggestEmailCorrection,
    validate: validateEmail,
    bindHint: bindEmailHint,
  };
})();
