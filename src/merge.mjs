// One row per role across sources, and the first-seen ledger that makes "new" mean new.
// Both pure.

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** One role: the same company and title, whatever the punctuation. "Example-Health" and "Example Health" are one company. */
export const dedupeKey = (j) => `${norm(j.company)}|${norm(j.title)}`;

// The company's own board is the real application form, so it wins over a Hacker News post.
const rank = (j) => (j.source === "hn" ? 1 : 0);

/**
 * One row per role. The better source wins (see `rank`, then first seen); the loser's name
 * goes in `alsoOn`, and its description fills in when the winner has none.
 */
export function mergeRoles(rows) {
  const byKey = new Map();
  for (const j of rows) {
    const k = dedupeKey(j);
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, j);
      continue;
    }
    const [win, lose] = rank(j) < rank(prev) ? [j, prev] : [prev, j];
    byKey.set(k, {
      ...win,
      text: win.text || lose.text,
      alsoOn: [...new Set([...(win.alsoOn ?? []), lose.source, ...(lose.alsoOn ?? [])])].filter((s) => s !== win.source),
    });
  }
  return [...byKey.values()];
}

/**
 * The ledger after one run: { [dedupeKey]: { first, last, score, url } }. Only listed jobs go
 * in, so a posting under the score, or a blocked one, is still new on the day it first lists.
 * Returns a new object; `seen` is not changed.
 */
export function updateLedger(seen, listed, today) {
  const out = { ...seen };
  for (const j of listed) {
    const k = dedupeKey(j);
    out[k] = { first: seen[k]?.first ?? today, last: today, score: j.score, url: j.url };
  }
  return out;
}
