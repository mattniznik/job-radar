// One run: read every source, then merge, check, score and sort into lanes.

import { dedupeKey, mergeRoles, updateLedger } from "./merge.mjs";
import { authCheck, scoreJob } from "./rules.mjs";
import { BOARD_FETCHERS, hackernews, pool } from "./sources.mjs";

/**
 * Read every board in `boards` and, when the config says so, Hacker News. A source that fails
 * is listed in `sources` with its error, never fatal. Returns every candidate and the counts.
 */
export async function collect(cfg, { get, boards = cfg.boards }) {
  const all = [];
  const sources = {};
  for (const [kind, fetch] of Object.entries(BOARD_FETCHERS)) {
    const tokens = boards[kind] ?? [];
    if (!tokens.length) continue;
    const r = { boards: tokens.length, total: 0, kept: 0, failed: [] };
    await pool(tokens, 6, async (t) => {
      try {
        const x = await fetch(t, { get, cfg });
        r.total += x.total;
        r.kept += x.jobs.length;
        all.push(...x.jobs);
      } catch (e) {
        r.failed.push(`${t}: ${e.message}`);
      }
    });
    sources[kind] = r;
  }
  if (cfg.hackernews) {
    try {
      const r = await hackernews({ get, cfg });
      sources.hn = { total: r.total, kept: r.jobs.length, failed: [], thread: r.thread };
      all.push(...r.jobs);
    } catch (e) {
      sources.hn = { total: 0, kept: 0, failed: [e.message] };
    }
  }
  // Boards finish in any order; sort so the same input always gives the same output.
  all.sort((a, b) => a.id.localeCompare(b.id));
  return { all, sources };
}

/** A run that read nothing, every source failed or empty, must not stand in for the last real one. */
export const readSomething = (sources) => Object.values(sources).some((s) => s.total > 0 || !s.failed?.length);

/**
 * Merge, check work authorization, score and sort into lanes. Pure: `seen` is the ledger
 * before this run, `now` the clock in ms, `today` the date the ledger records.
 *   keep, sales, maybe   the posting's tier, at minScore or above
 *   blocked              a workAuth `block` pattern matched, whatever the score
 *   below                under minScore: counted and stored, not listed
 */
export function rank(all, cfg, { seen = {}, now, today }) {
  const lanes = { keep: [], sales: [], maybe: [], blocked: [] };
  const jobs = [];
  for (const j of mergeRoles(all)) {
    const auth = authCheck(j.text, cfg);
    const job = { ...j, ...scoreJob(j, cfg, now), flags: auth.flags, isNew: !seen[dedupeKey(j)] };
    if (auth.blocked) {
      job.blocked = auth.blocked;
      job.lane = "blocked";
    } else job.lane = job.score < cfg.minScore ? "below" : job.tier;
    if (lanes[job.lane]) lanes[job.lane].push(job);
    jobs.push(job);
  }
  for (const l of Object.values(lanes)) l.sort((a, b) => b.isNew - a.isNew || b.score - a.score);
  const listed = [...lanes.keep, ...lanes.sales, ...lanes.maybe];
  return {
    lanes,
    jobs,
    ledger: updateLedger(seen, listed, today),
    counts: {
      lanes: Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, v.length])),
      new: lanes.keep.filter((j) => j.isNew).length,
      below: jobs.filter((j) => j.lane === "below").length,
    },
  };
}
