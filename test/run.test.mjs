// Whole runs through main() into a temp folder: the files a run writes, the ledger across two
// days, the database, and the rule that a run which read nothing writes nothing. fetch is
// replaced with one that fails the test, so a request that slips past the fixtures shows up.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { main } from "../bin/radar.mjs";
import { fixtureGet } from "../src/sources.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(ROOT, "fixtures");
const quiet = () => {};

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "job-radar-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function noNetwork(t) {
  return t.mock.method(globalThis, "fetch", async (url) => {
    throw new Error(`a test reached the network: ${url}`);
  });
}

/** The example config with its boards pointed at the fixtures, for a "live" run that reads the ledger. */
function fixtureConfig(dir) {
  const raw = parse(readFileSync(join(ROOT, "radar.example.yaml"), "utf8"));
  raw.boards = { greenhouse: ["example-robotics"], lever: ["acme-analytics"], ashby: ["example-health"] };
  const file = join(dir, "radar.yaml");
  writeFileSync(file, stringify(raw));
  return file;
}

const query = (file, sql) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
};

test("an offline run sorts the fixtures into lanes and writes the report, jobs.json, the ledger and the database", async (t) => {
  const fetch = noNetwork(t);
  const out = tempDir(t);
  const summary = await main({ offline: true, out, today: "2026-11-11", log: quiet });

  assert.equal(fetch.mock.callCount(), 0, "offline never calls fetch");
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.lanes, { keep: 6, sales: 1, maybe: 1, blocked: 2 });
  assert.equal(summary.below, 2);

  const { jobs } = JSON.parse(readFileSync(join(out, "jobs.json"), "utf8"));
  const lane = Object.fromEntries(jobs.map((j) => [`${j.company} / ${j.title}`, j.lane]));
  assert.deepEqual(lane, {
    "Example Robotics / Forward Deployed Engineer": "keep",
    "Example Robotics / Applied AI Engineer, Public Sector": "blocked",
    "Example Robotics / Solutions Engineer": "keep",
    "acme-analytics / AI Solutions Engineer": "keep",
    "acme-analytics / Account Executive": "sales",
    "acme-analytics / Full Stack Engineer": "maybe",
    "example-health / Forward Deployed Engineer": "keep",
    "example-health / Machine Learning Engineer": "keep",
    "example-health / Product Engineer": "below",
    "Granite Ledger / Applied AI Engineer": "blocked",
    "Tiny Mill / Founding Solutions Engineer": "keep",
    "Bright Kiln / Senior Software Engineer": "below",
  });
  assert.ok(jobs.every((j) => j.text === undefined), "descriptions stay out of jobs.json");
  const eh = jobs.find((j) => j.company === "example-health" && j.title === "Forward Deployed Engineer");
  assert.deepEqual(eh.alsoOn, ["hn"], "the HN post of the same role merged into the Ashby row");
  const se = jobs.find((j) => j.title === "Solutions Engineer");
  assert.deepEqual(se.flags.map((f) => f.kind), ["noSponsorship"]);

  const html = readFileSync(join(out, "report.html"), "utf8");
  assert.match(html, /Example Robotics/);
  assert.match(html, /secret clearance/i, "the blocking sentence is in the report");
  assert.match(html, /nothing here has been applied to/);

  assert.equal(Object.keys(JSON.parse(readFileSync(join(out, "seen.json"), "utf8"))).length, 8, "only listed jobs enter the ledger");
  assert.deepEqual(query(join(out, "radar.db"), "SELECT count(*) n FROM postings")[0].n, 12);
  const hit = query(join(out, "radar.db"), "SELECT p.title FROM postings_fts f JOIN postings p ON p.rowid = f.rowid WHERE postings_fts MATCH 'clinical'");
  assert.deepEqual(hit.map((r) => r.title), ["Forward Deployed Engineer"], "full-text search over descriptions");
});

test("the same fixtures and date give the same report, so the sample report can be regenerated", async (t) => {
  noNetwork(t);
  const [a, b] = [tempDir(t), tempDir(t)];
  await main({ offline: true, out: a, today: "2026-11-11", log: quiet });
  await main({ offline: true, out: b, today: "2026-11-11", log: quiet });
  assert.equal(readFileSync(join(a, "report.html"), "utf8"), readFileSync(join(b, "report.html"), "utf8"));
});

test("across two days the ledger keeps the first date, nothing is new the second day, and the database counts both", async (t) => {
  noNetwork(t);
  const dir = tempDir(t);
  const opts = { config: fixtureConfig(dir), out: join(dir, "out"), get: fixtureGet(FIXTURES), log: quiet };
  const day1 = await main({ ...opts, today: "2026-11-10" });
  const day2 = await main({ ...opts, today: "2026-11-11" });
  await main({ ...opts, today: "2026-11-11" }); // a re-run the same day replaces that day's rows

  assert.equal(day1.new, 6);
  assert.equal(day2.new, 0);
  const seen = JSON.parse(readFileSync(join(opts.out, "seen.json"), "utf8"));
  assert.deepEqual(seen["tiny mill|founding solutions engineer"], { ...seen["tiny mill|founding solutions engineer"], first: "2026-11-10", last: "2026-11-11" });

  const db = join(opts.out, "radar.db");
  assert.deepEqual(query(db, "SELECT run FROM runs ORDER BY run").map((r) => r.run), ["2026-11-10", "2026-11-11"]);
  assert.equal(query(db, "SELECT count(*) n FROM sightings")[0].n, 24, "12 postings on each of 2 days, the re-run not doubled");
  const tiny = query(db, "SELECT first_seen, last_seen, days_seen FROM postings WHERE title = 'Founding Solutions Engineer'")[0];
  assert.deepEqual({ ...tiny }, { first_seen: "2026-11-10", last_seen: "2026-11-11", days_seen: 2 });
});

test("a run that read no source writes nothing, so the last good report stays", async (t) => {
  noNetwork(t);
  const out = tempDir(t);
  const empty = join(out, "no-fixtures");
  mkdirSync(empty);
  writeFileSync(join(out, "report.html"), "<p>last good run</p>");

  const summary = await main({ offline: true, fixtures: empty, out, today: "2026-11-11", log: quiet });

  assert.equal(summary.ok, false);
  assert.deepEqual(summary.sources, { hn: { total: 0, kept: 0, failed: ["HTTP 404"] } });
  assert.equal(readFileSync(join(out, "report.html"), "utf8"), "<p>last good run</p>");
  for (const f of ["jobs.json", "seen.json", "radar.db"]) assert.equal(existsSync(join(out, f)), false, `${f} not written`);
});

test("the command line runs offline, prints a JSON summary last, and rejects an unknown flag", (t) => {
  const out = tempDir(t);
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, "bin", "radar.mjs"), ...args], { encoding: "utf8" });

  const ok = run("--offline", "--today", "2026-11-11", "--out", out);
  assert.equal(ok.status, 0, ok.stderr);
  const last = JSON.parse(ok.stdout.trim().split("\n").at(-1));
  assert.deepEqual(last.lanes, { keep: 6, sales: 1, maybe: 1, blocked: 2 });

  const bad = run("--apply");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown argument --apply/);
});
