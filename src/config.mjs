// Reads a radar YAML file and compiles it into the regexes the rules use. A setting that
// cannot work (no profiles, an unknown tier, a bad regex) throws here, before any request.

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { anyRe, esc, NEVER, wordRe } from "./text.mjs";

export const TIERS = new Set(["keep", "sales", "maybe", "drop"]);

const words = (list) => (list ?? []).map(String);
const terms = (list) => [...new Set(words(list))].map((term) => ({ term, re: wordRe([term]) }));

/** Whole-word regexes, so "ITAR" in a pattern does not fire inside "military". */
const authGroups = (groups) =>
  Object.entries(groups ?? {})
    .filter(([, pats]) => pats?.length)
    .map(([kind, pats]) => ({
    kind,
    re: new RegExp(pats.map((p) => `(?<![a-z0-9])(?:${p})(?![a-z0-9])`).join("|"), "i"),
  }));

/**
 * Region words are matched with the case as written, so "CA" does not match the letters in
 * "Canada" or "Chicago".
 */
const caseRe = (list) => (list.length ? new RegExp(`(?<![A-Za-z])(?:${list.map(esc).join("|")})(?![A-Za-z])`) : NEVER);

/** The YAML object, compiled. Exported so tests can build a config without a file. */
export function compileConfig(raw = {}) {
  const profiles = Object.entries(raw.profiles ?? {}).map(([name, p]) => ({
    name,
    titles: wordRe(words(p?.titles)),
    keywords: terms(p?.keywords),
    avoid: terms(p?.avoid),
  }));
  if (!profiles.length) throw new Error("config: add at least one profile under `profiles`");

  const types = (raw.types ?? []).map((t) => {
    if (!TIERS.has(t.tier)) throw new Error(`config: type "${t.name}" has tier "${t.tier}"; use one of ${[...TIERS].join(", ")}`);
    return { name: t.name, tier: t.tier, re: anyRe(words(t.titles)) };
  });

  const loc = raw.location ?? {};
  return {
    profiles,
    types,
    skipTitles: wordRe(words(raw.skipTitles)),
    location: {
      places: wordRe(words(loc.places)),
      preferred: wordRe(words(loc.preferred)),
      region: caseRe(words(loc.region)),
      bare: wordRe(words(loc.bare)),
      elsewhere: wordRe(words(loc.elsewhere)),
      remote: loc.remote !== false,
    },
    minScore: Number(raw.minScore ?? 45),
    salaryFloor: Number(raw.salaryFloor ?? 0),
    workAuth: { block: authGroups(raw.workAuth?.block), flag: authGroups(raw.workAuth?.flag) },
    boards: {
      greenhouse: words(raw.boards?.greenhouse),
      lever: words(raw.boards?.lever),
      ashby: words(raw.boards?.ashby),
    },
    hackernews: raw.hackernews === true,
  };
}

/** Read and compile a config file. */
export const loadConfig = (file) => compileConfig(parse(readFileSync(file, "utf8")));
