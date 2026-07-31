/**
 * Catch common email-domain typos before we accept a request.
 * Format-valid addresses like you@sol.com still bounce forever — this
 * blocks the frequent fat-finger cases (sol→aol, gmial→gmail, etc.).
 */

/** Known bad domain → intended domain. Keys are lowercase. */
const DOMAIN_TYPOS: Record<string, string> = {
  // AOL
  "sol.com": "aol.com",
  "aoll.com": "aol.com",
  "apl.com": "aol.com",
  "ao.com": "aol.com",
  "aol.co": "aol.com",
  "aol.con": "aol.com",
  "aol.cm": "aol.com",
  "aol.om": "aol.com",
  // Gmail
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
  // Yahoo
  "yaho.com": "yahoo.com",
  "yahooo.com": "yahoo.com",
  "yahu.com": "yahoo.com",
  "yahoo.co": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "yahoo.cm": "yahoo.com",
  "yhoo.com": "yahoo.com",
  // Hotmail / Outlook / Live / MSN
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
  // iCloud / Me / Mac
  "iclou.com": "icloud.com",
  "icloud.co": "icloud.com",
  "icloud.con": "icloud.com",
  "icloud.cm": "icloud.com",
  "me.co": "me.com",
  "mac.co": "mac.com",
  // Comcast / Verizon / ATT / Spectrum
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

/** Bare TLD typos applied when the domain itself isn't in DOMAIN_TYPOS. */
const TLD_TYPOS: Record<string, string> = {
  con: "com",
  cmo: "com",
  ocm: "com",
  comm: "com",
  ent: "net",
  nett: "net",
};

export type EmailSuggestion = {
  email: string;
  domain: string;
  suggestedDomain: string;
  suggestedEmail: string;
};

function splitEmail(email: string): { local: string; domain: string } | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!local || !domain || domain.includes("@")) return null;
  return { local, domain };
}

/** If the domain looks like a known typo, return the corrected address. */
export function suggestEmailCorrection(email: string): EmailSuggestion | null {
  const parts = splitEmail(email);
  if (!parts) return null;

  const { local, domain } = parts;
  let suggestedDomain = DOMAIN_TYPOS[domain];

  if (!suggestedDomain) {
    const dot = domain.lastIndexOf(".");
    if (dot > 0) {
      const name = domain.slice(0, dot);
      const tld = domain.slice(dot + 1);
      const fixedTld = TLD_TYPOS[tld];
      if (fixedTld) {
        suggestedDomain = `${name}.${fixedTld}`;
      }
    }
  }

  if (!suggestedDomain || suggestedDomain === domain) return null;

  return {
    email: `${local}@${domain}`,
    domain,
    suggestedDomain,
    suggestedEmail: `${local}@${suggestedDomain}`,
  };
}

/** True when the address uses a known-bad domain we should reject. */
export function hasEmailDomainTypo(email: string): boolean {
  return suggestEmailCorrection(email) !== null;
}
