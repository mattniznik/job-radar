// Every run into one SQLite file, through node:sqlite (built into Node 22, no dependency).
// WAL and a busy timeout, so Datasette or the sqlite3 shell can read while a run writes.
//
//   postings    one row per posting id, with first and last day seen and its best score
//   sightings   one row per posting per run: the lane and score that day
//   runs        one row per run, with its source counts
//   postings_fts  full-text search over title, company and description

import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS postings (
  id TEXT PRIMARY KEY, source TEXT, company TEXT, title TEXT, same_job TEXT,
  place TEXT, place_kind TEXT, pay_min INTEGER, pay_max INTEGER, posted TEXT,
  url TEXT, apply_url TEXT, apply_via TEXT, also_on TEXT, emails TEXT,
  profile TEXT, type TEXT, tier TEXT, blocked TEXT, blocked_quote TEXT, flags TEXT,
  why TEXT, keywords TEXT, description TEXT,
  first_seen TEXT, last_seen TEXT, days_seen INTEGER, last_lane TEXT, last_score INTEGER, best_score INTEGER
);
CREATE TABLE IF NOT EXISTS sightings (
  posting_id TEXT NOT NULL REFERENCES postings(id), run TEXT NOT NULL,
  lane TEXT, score INTEGER, is_new INTEGER, PRIMARY KEY (posting_id, run)
);
CREATE INDEX IF NOT EXISTS sightings_run ON sightings(run, lane);
CREATE TABLE IF NOT EXISTS runs (run TEXT PRIMARY KEY, postings INTEGER, listed INTEGER, below INTEGER, blocked INTEGER, sources TEXT, loaded TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS postings_fts USING fts5(title, company, description, content='postings', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS postings_ai AFTER INSERT ON postings BEGIN
  INSERT INTO postings_fts(rowid, title, company, description) VALUES (new.rowid, new.title, new.company, new.description);
END;
CREATE TRIGGER IF NOT EXISTS postings_au AFTER UPDATE OF title, company, description ON postings BEGIN
  INSERT INTO postings_fts(postings_fts, rowid, title, company, description) VALUES ('delete', old.rowid, old.title, old.company, old.description);
  INSERT INTO postings_fts(rowid, title, company, description) VALUES (new.rowid, new.title, new.company, new.description);
END;
CREATE VIEW IF NOT EXISTS latest_run AS
  SELECT s.lane, s.score, s.is_new, p.* FROM sightings s JOIN postings p ON p.id = s.posting_id
  WHERE s.run = (SELECT max(run) FROM runs);
`;

const list = (a, f = (x) => x) => (Array.isArray(a) && a.length ? a.map(f).join(", ") : null);
const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);

/** A ranked job as one postings row. node:sqlite takes null, numbers and strings, never undefined or booleans. */
export function toRow(j, sameJob) {
  return {
    id: j.id,
    source: j.source ?? null,
    company: j.company ?? null,
    title: j.title ?? null,
    same_job: sameJob,
    place: j.place?.text ?? null,
    place_kind: j.place?.kind ?? null,
    pay_min: int(j.pay?.min),
    pay_max: int(j.pay?.max),
    posted: j.posted ?? null,
    url: j.url ?? null,
    apply_url: j.applyUrl ?? null,
    apply_via: j.applyVia ?? null,
    also_on: list(j.alsoOn),
    emails: list(j.emails),
    profile: j.profile ?? null,
    type: j.type ?? null,
    tier: j.tier ?? null,
    blocked: j.blocked?.kind ?? null,
    blocked_quote: j.blocked?.quote ?? null,
    flags: list(j.flags, (f) => f.kind),
    why: list(j.why),
    keywords: list(j.hits),
    description: j.text || null,
  };
}

/**
 * Store one run. Running the same `run` again replaces its sightings rather than adding a
 * second set, so a re-run on the same day is safe.
 */
export function saveRun(file, { run, jobs, sources, keyOf }) {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA);
    const cols = Object.keys(toRow({}, null));
    const upsert = db.prepare(
      `INSERT INTO postings (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})
       ON CONFLICT(id) DO UPDATE SET ${cols
         .filter((c) => c !== "id")
         .map((c) => `${c} = COALESCE(excluded.${c}, ${c})`)
         .join(", ")}`,
    );
    const sight = db.prepare("INSERT INTO sightings (posting_id, run, lane, score, is_new) VALUES (?, ?, ?, ?, ?)");
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM sightings WHERE run = ?").run(run);
      for (const j of jobs) {
        upsert.run(toRow(j, keyOf(j)));
        sight.run(j.id, run, j.lane, int(j.score), j.isNew ? 1 : 0);
      }
      const count = (pred) => jobs.filter(pred).length;
      db.prepare("INSERT OR REPLACE INTO runs (run, postings, listed, below, blocked, sources, loaded) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        run,
        jobs.length,
        count((j) => ["keep", "sales", "maybe"].includes(j.lane)),
        count((j) => j.lane === "below"),
        count((j) => j.lane === "blocked"),
        JSON.stringify(sources),
        new Date().toISOString(),
      );
      // The history columns, from every sighting.
      db.exec(`UPDATE postings SET
        first_seen = (SELECT min(run) FROM sightings s WHERE s.posting_id = postings.id),
        last_seen  = (SELECT max(run) FROM sightings s WHERE s.posting_id = postings.id),
        days_seen  = (SELECT count(DISTINCT run) FROM sightings s WHERE s.posting_id = postings.id),
        best_score = (SELECT max(score) FROM sightings s WHERE s.posting_id = postings.id),
        last_score = (SELECT score FROM sightings s WHERE s.posting_id = postings.id ORDER BY run DESC LIMIT 1),
        last_lane  = (SELECT lane FROM sightings s WHERE s.posting_id = postings.id ORDER BY run DESC LIMIT 1)`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db.close();
  }
}
