// Dedupe across sources and the first-seen ledger. Pure functions, invented rows.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { dedupeKey, mergeRoles, updateLedger } from "../src/merge.mjs";

const hn = { id: "hn:1", source: "hn", company: "Example Health", title: "Forward Deployed Engineer", text: "From the HN post.", applyUrl: "https://news.ycombinator.com/item?id=1" };
const ashby = { id: "ashby:example-health:1", source: "ashby", company: "example-health", title: "Forward Deployed Engineer", text: "", applyUrl: "https://jobs.ashbyhq.com/example-health/1" };

test("one role listed on a company board and on HN is one row: the board wins and HN is named", () => {
  const [one, ...rest] = mergeRoles([hn, ashby]);
  assert.equal(rest.length, 0);
  assert.equal(one.id, ashby.id, "the company's own board is the real form");
  assert.equal(one.applyUrl, ashby.applyUrl);
  assert.deepEqual(one.alsoOn, ["hn"]);
  assert.equal(one.text, "From the HN post.", "the board row had no description, so it borrows the twin's");
});

test("the order the sources arrive in does not change the winner", () => {
  assert.equal(mergeRoles([ashby, hn])[0].id, ashby.id);
});

test("case and punctuation do not split a role; a different title does", () => {
  assert.equal(dedupeKey({ company: "Example-Health", title: "Forward Deployed Engineer" }), dedupeKey({ company: "example health", title: "Forward  Deployed, Engineer" }));
  assert.equal(mergeRoles([ashby, { ...hn, title: "Solutions Engineer" }]).length, 2);
});

test("the ledger makes new mean new: first day listed is kept, later days only move `last`", () => {
  const job = { company: "Acme", title: "AI Engineer", score: 70, url: "https://example.com/1" };
  const day1 = updateLedger({}, [job], "2026-11-10");
  assert.deepEqual(day1[dedupeKey(job)], { first: "2026-11-10", last: "2026-11-10", score: 70, url: "https://example.com/1" });
  const day2 = updateLedger(day1, [{ ...job, score: 74 }], "2026-11-11");
  assert.deepEqual(day2[dedupeKey(job)], { first: "2026-11-10", last: "2026-11-11", score: 74, url: "https://example.com/1" });
  assert.equal(day1[dedupeKey(job)].last, "2026-11-10", "the old ledger object is not changed");
});
