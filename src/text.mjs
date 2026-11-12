// Text helpers shared by the fetchers and the rules: HTML to plain text, whole-word patterns,
// and pay. Everything here is pure.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decode named and numeric HTML entities. An unknown name is left as written. */
export const decode = (s) =>
  String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] !== "#"
      ? (ENTITIES[e.toLowerCase()] ?? m)
      : String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)),
  );

/**
 * Greenhouse ships its HTML entity-encoded ("&lt;p&gt;..."), so decode once to get the tags,
 * strip them, then decode again for the text. Block ends become line breaks.
 */
export const htmlToText = (html = "") =>
  decode(
    decode(html ?? "")
      .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n") // a tag after a line break left a space at the start of the line
    .replace(/\n\s*\n+/g, "\n")
    .trim();

/** Matches nothing. An empty list in the config must mean "none", never "everything". */
export const NEVER = /(?!)/;

export const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Any of the phrases as whole words, case-insensitive. The edges are "not a letter or digit"
 * rather than \b, so "full-stack" and "C++" work, and "ITAR" does not match "military".
 */
export const wordRe = (phrases = []) =>
  phrases.length ? new RegExp(`(?<![a-z0-9])(?:${phrases.map(esc).join("|")})(?![a-z0-9])`, "i") : NEVER;

/** Any of the regexes as written, case-insensitive. */
export const anyRe = (patterns = []) => (patterns.length ? new RegExp(patterns.join("|"), "i") : NEVER);

/** Normalise to a yearly base. Hourly x 2080, the usual full-time year. */
export function pay(min, max, interval, text = null) {
  if (!min && !max) return null;
  const k = /hour/i.test(interval ?? "") ? 2080 : 1;
  return { min: min ? min * k : null, max: max ? max * k : null, text };
}

// "$120,000 - $160,000", "$150k to $190k", and the en or em dash forms.
const AMOUNT = String.raw`(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d)?\s?[kK])`;
const PAY_RE = new RegExp(String.raw`\$\s?${AMOUNT}\s*(?:-|\u2013|\u2014|to)\s*\$?\s?${AMOUNT}`);

/** A yearly range printed in the text, which many US states require. Null when there is none. */
export function payFromText(text) {
  const m = PAY_RE.exec(text ?? "");
  if (!m) return null;
  const n = (s) => (/k$/i.test(s.trim()) ? parseFloat(s) * 1000 : Number(s.replace(/,/g, "")));
  const [min, max] = [n(m[1]), n(m[2])];
  if (min < 20000 || max < min) return null; // an hourly rate or a typo, not a yearly range
  return { min, max, text: m[0] };
}

/** "$150k-$190k" for the report. */
export const money = (p) => (!p ? "" : [p.min, p.max].filter(Boolean).map((v) => `$${Math.round(v / 1000)}k`).join("-"));
