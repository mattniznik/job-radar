#!/usr/bin/env node
// job-radar: read public job boards, rank postings against your config, write a report.
// It finds and ranks. It never applies.
//
//   node bin/radar.mjs                          live run with ./radar.yaml, writes ./output
//   node bin/radar.mjs --offline                the bundled fixtures instead of the network,
//                                               with radar.example.yaml unless --config is given
//   node bin/radar.mjs --config my.yaml --out runs/today
//   node bin/radar.mjs --today 2026-11-11       pin the date (and the clock the score uses)
//   node bin/radar.mjs --report docs/x.html     also write the HTML report to this file
//
// Writes into --out: report.html, jobs.json, seen.json (the first-seen ledger) and radar.db.
// A run that read nothing at all writes nothing and exits 1, so the last good report stays.
// An offline run starts from an empty ledger, so the same fixtures always give the same report.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { dedupeKey } from "../src/merge.mjs";
import { collect, rank, readSomething } from "../src/radar.mjs";
import { render } from "../src/report.mjs";
import { fixtureBoards, fixtureGet, getJson } from "../src/sources.mjs";
import { saveRun } from "../src/store.mjs";
import { money } from "../src/text.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Write through a temp file and a rename, so a crash never leaves half a ledger. */
function writeAtomic(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, body);
  renameSync(`${file}.tmp`, file);
}

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback);

/** One run. Every path is an option so the tests can point it at a temp folder. Returns the summary. */
export async function main({
  offline = false,
  config = offline ? join(ROOT, "radar.example.yaml") : "radar.yaml",
  fixtures = join(ROOT, "fixtures"),
  out = "output",
  today: pinned = null,
  report = null,
  get = offline ? fixtureGet(fixtures) : getJson,
  log = console.log,
} = {}) {
  if (!existsSync(config)) throw new Error(`no config at ${config}: copy radar.example.yaml to radar.yaml and edit it, or run with --offline`);
  const cfg = loadConfig(config);
  // The local date, not UTC: an evening run must not file itself under tomorrow.
  const today = pinned ?? new Date().toLocaleDateString("en-CA");
  const now = pinned || offline ? Date.parse(`${today}T12:00:00Z`) : Date.now();

  const { all, sources } = await collect(cfg, { get, boards: offline ? fixtureBoards(fixtures) : cfg.boards });
  const seenFile = join(out, "seen.json");
  const seen = offline ? {} : readJson(seenFile, {});
  const { lanes, jobs, ledger, counts } = rank(all, cfg, { seen, now, today });
  const summary = { ok: readSomething(sources), date: today, offline, sources, ...counts, report: null };

  for (const [k, v] of Object.entries(sources)) log(`${k}: ${v.kept} kept of ${v.total}${v.failed.length ? `, FAILED ${v.failed.join("; ")}` : ""}`);
  if (!summary.ok) {
    log(`No source read, so nothing was written. ${join(out, "report.html")} still holds the last run that read.`);
    return summary;
  }

  const html = render(lanes, summary, { minScore: cfg.minScore, now });
  const strip = ({ text, ...j }) => j; // descriptions go to the database, keeping jobs.json small
  writeAtomic(join(out, "report.html"), html);
  if (report) writeAtomic(report, html);
  writeAtomic(join(out, "jobs.json"), JSON.stringify({ summary, jobs: jobs.map(strip) }, null, 1));
  writeAtomic(seenFile, JSON.stringify(ledger, null, 1));
  saveRun(join(out, "radar.db"), { run: today, jobs, sources, keyOf: dedupeKey });
  summary.report = join(out, "report.html");

  const line = (j) => `  ${String(j.score).padStart(3)} ${j.isNew ? "NEW " : "    "}${j.title} - ${j.company} (${j.place.kind}${j.pay ? ", " + money(j.pay) : ""}) ${j.applyVia}${j.flags.length ? " [" + j.flags.map((f) => f.kind).join(", ") + "]" : ""}\n       ${j.applyUrl}`;
  log(`\nMatches (${lanes.keep.length}), top 15:`);
  lanes.keep.slice(0, 15).forEach((j) => log(line(j)));
  log(`\nSales ${lanes.sales.length}, maybe ${lanes.maybe.length}, not eligible ${lanes.blocked.length}, under score ${cfg.minScore}: ${counts.below}`);
  // The matched sentence, so a false positive shows in the log too.
  lanes.blocked.forEach((j) => log(`  [${j.blocked.kind}] ${j.title} - ${j.company}: ${j.blocked.quote}`));
  log(`Report: ${summary.report}${report ? ` and ${report}` : ""}`);
  return summary;
}

/** --flag value pairs and bare --flags. */
function parseArgs(argv) {
  const opts = {};
  const valued = { "--config": "config", "--out": "out", "--today": "today", "--report": "report" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--offline") opts.offline = true;
    else if (valued[argv[i]] && argv[i + 1]) opts[valued[argv[i]]] = argv[++i];
    else throw new Error(`unknown argument ${argv[i]} (see the usage lines at the top of bin/radar.mjs)`);
  }
  if (opts.today && !/^\d{4}-\d{2}-\d{2}$/.test(opts.today)) throw new Error("--today takes YYYY-MM-DD");
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(parseArgs(process.argv.slice(2)))
    .then((summary) => {
      console.log(JSON.stringify({ ok: summary.ok, date: summary.date, lanes: summary.lanes, new: summary.new, below: summary.below, report: summary.report }));
      if (!summary.ok) process.exitCode = 1;
    })
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
}
