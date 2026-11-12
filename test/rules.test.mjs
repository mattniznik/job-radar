// The pure rules: config compile, title classification, place, work authorization, score,
// and the text helpers they rest on. A small config built here, a pinned clock, no files.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compileConfig, loadConfig } from "../src/config.mjs";
import { authCheck, candidate, placeOf, profileOf, scoreJob, typeOf, WEIGHTS } from "../src/rules.mjs";
import { htmlToText, pay, payFromText } from "../src/text.mjs";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 864e5).toISOString();

const RAW = {
  profiles: {
    ai: { titles: ["forward deployed", "applied ai"], keywords: ["Python", "LLM", "RAG", "evals", "APIs", "AWS", "SQL", "TypeScript"], avoid: ["Java", "Scala", "Golang", "Kotlin"] },
    engineering: { titles: ["software engineer"], keywords: ["React"] },
  },
  skipTitles: ["staff", "intern"],
  types: [
    { name: "FDE", tier: "keep", titles: ["forward.deploy", "applied ai"] },
    { name: "Platform", tier: "drop", titles: ["platform"] },
  ],
  location: {
    places: ["San Francisco", "Oakland", "Glendale"],
    preferred: ["San Francisco"],
    region: ["CA", "California"],
    bare: ["San Francisco", "Glendale"],
    elsewhere: ["Atlanta"],
  },
  minScore: 45,
  salaryFloor: 120000,
  workAuth: {
    block: { clearance: ["security clearance", "secret clearance"], usPerson: ["ITAR"] },
    flag: { noSponsorship: ["(unable|will not|do not)( to)?( provide| offer)?( visa)? sponsor(ship|ing)?", "without (any )?(visa )?sponsorship(?! for an? export)"] },
  },
};
const cfg = compileConfig(RAW);

test("a title takes the first type row that matches, and a title no row catches is a maybe", () => {
  assert.equal(typeOf("Forward Deployed Engineer", cfg).name, "FDE");
  assert.deepEqual(typeOf("Software Engineer, Payments", cfg), { name: "Other", tier: "maybe" });
});

test("a skipped title or a drop type has no profile, so it is never read", () => {
  assert.equal(profileOf("Forward Deployed Engineer", cfg), "ai");
  assert.equal(profileOf("Staff Forward Deployed Engineer", cfg), null, "skipTitles");
  assert.equal(profileOf("Software Engineer, Platform", cfg), null, "a drop type");
  assert.equal(profileOf("Mechanical Engineer", cfg), null, "no profile matches");
});

test("an empty list in the config matches nothing, never everything", () => {
  const empty = compileConfig({ ...RAW, skipTitles: [], types: [{ name: "None", tier: "drop", titles: [] }], workAuth: { block: { clearance: [] }, flag: {} } });
  assert.equal(profileOf("Forward Deployed Engineer", empty), "ai", "an empty skip list and an empty drop row skip nothing");
  assert.equal(authCheck("Any posting at all.", empty).blocked, null, "an empty block group blocks nothing");
});

test("a config that cannot work fails before any request, naming what is wrong", () => {
  assert.throws(() => compileConfig({ profiles: {} }), /at least one profile/);
  assert.throws(() => compileConfig({ ...RAW, types: [{ name: "Oops", tier: "later", titles: ["x"] }] }), /type "Oops" has tier "later"/);
  assert.ok(loadConfig(new URL("../radar.example.yaml", import.meta.url)).profiles.length > 0, "the example config compiles");
});

test("a place is local when it says the region, or is a bare name with no other state beside it", () => {
  const L = cfg.location;
  assert.deepEqual(placeOf(["Oakland, CA"], false, L), { kind: "local", preferred: false, text: "Oakland, CA" });
  assert.equal(placeOf(["Oakland"], false, L), null, "Oakland is not a bare name, so it needs CA");
  assert.equal(placeOf(["Glendale"], false, L).kind, "local", "a bare name alone counts");
  assert.equal(placeOf(["Glendale, AZ"], false, L), null, "a bare name beside another state does not");
  assert.equal(placeOf(["Glendale, Arizona"], false, L), null);
});

test("Greenhouse's bullet-separated location is split, so a bare local name beside another city's state counts", () => {
  // Read whole, ", NY" would sit beside the bare "San Francisco" and disqualify it.
  const p = placeOf(["San Francisco \u2022 New York, NY"], false, cfg.location);
  assert.equal(p?.kind, "local");
  assert.equal(p.preferred, true);
});

test("remote counts with a US option, scores lower with no country, and is dropped outside the US", () => {
  const L = cfg.location;
  assert.equal(placeOf(["Remote - US"], false, L).kind, "remote-us");
  assert.equal(placeOf(["United States"], true, L).kind, "remote-us", "the board's remote flag");
  assert.equal(placeOf(["Remote"], false, L).kind, "remote-unclear");
  assert.equal(placeOf(["Remote - London"], false, L), null);
  assert.equal(placeOf(["Austin, TX"], false, L), null, "onsite elsewhere");
  assert.equal(placeOf(["Remote - US"], false, compileConfig({ ...RAW, location: { ...RAW.location, remote: false } }).location), null, "remote: false");
});

test("a title naming somewhere else is a job based there, unless the posting is local anyway", () => {
  assert.equal(candidate({ title: "Forward Deployed Engineer (Atlanta)", locs: ["Remote - US"] }, cfg), null);
  assert.equal(candidate({ title: "Applied AI Engineer - UK", locs: ["Remote"] }, cfg), null, "a country in the title");
  const local = candidate({ title: "Forward Deployed Engineer (Atlanta)", locs: ["Oakland, CA"] }, cfg);
  assert.equal(local.place.kind, "local");
  assert.equal(local.profile, "ai");
  assert.equal(local.tier, "keep");
});

test("a work-auth block carries the sentence that matched; a flag keeps the job and its sentence", () => {
  const text = "You will travel to customers. This role requires an active Secret clearance before day one. Python.";
  const { blocked } = authCheck(text, cfg);
  assert.equal(blocked.kind, "clearance");
  assert.match(blocked.quote, /requires an active Secret clearance before day one/);

  const flagged = authCheck("Great team. We are unable to provide visa sponsorship for this role.", cfg);
  assert.equal(flagged.blocked, null);
  assert.deepEqual(flagged.flags.map((f) => f.kind), ["noSponsorship"]);
  assert.match(flagged.flags[0].quote, /unable to provide visa sponsorship/);
});

test("whole words only: an EEO footer's 'military' is not ITAR, and export-licence wording is not a visa", () => {
  const eeo = "We do not discriminate on the basis of protected veteran or military status.";
  assert.equal(authCheck(eeo, cfg).blocked, null);
  assert.equal(authCheck("Shipped without sponsorship for an export license.", cfg).flags.length, 0);
  assert.equal(authCheck("Subject to ITAR.", cfg).blocked.kind, "usPerson");
});

const job = (over = {}) => ({ profile: "ai", type: "FDE", place: { kind: "remote-us" }, text: "", posted: null, ...over });

test("keyword hits carry the score: 8 each, capped at 48, and each one is named", () => {
  const two = scoreJob(job({ text: "Python and RAG." }), cfg, NOW);
  assert.equal(two.score, WEIGHTS.base + 2 * 8 + 15);
  assert.deepEqual(two.hits, ["Python", "RAG"]);
  const all = scoreJob(job({ text: "Python LLM RAG evals APIs AWS SQL TypeScript" }), cfg, NOW);
  assert.equal(all.hits.length, 8);
  assert.equal(all.score, WEIGHTS.base + 48 + 15, "8 hits would be 64 points; the cap holds it at 48");
});

test("avoid words cost 5 each, capped at 15, and say what the posting asks for", () => {
  const r = scoreJob(job({ text: "Python. Java, Scala, Golang and Kotlin." }), cfg, NOW);
  assert.equal(r.score, WEIGHTS.base + 8 - 15 + 15);
  assert.ok(r.why.includes("asks for Java, Scala, Golang, Kotlin"));
});

test("place moves the score: preferred 25, local 15, remote US 15, remote with no country 5", () => {
  const at = (place) => scoreJob(job({ place }), cfg, NOW).score - WEIGHTS.base;
  assert.equal(at({ kind: "local", preferred: true }), 25);
  assert.equal(at({ kind: "local", preferred: false }), 15);
  assert.equal(at({ kind: "remote-us" }), 15);
  assert.equal(at({ kind: "remote-unclear" }), 5);
});

test("age moves the score against a pinned clock: fresh up, old down, very old further down", () => {
  const at = (n) => scoreJob(job({ posted: daysAgo(n) }), cfg, NOW);
  assert.equal(at(3).score, WEIGHTS.base + 15 + 5);
  assert.equal(at(20).score, WEIGHTS.base + 15);
  assert.equal(at(60).score, WEIGHTS.base + 15 - 10);
  assert.ok(at(60).why.includes("posted 60 days ago"));
  assert.equal(at(200).score, WEIGHTS.base + 15 - 20);
});

test("pay that tops out under the floor costs 25; the floor reads hourly pay as a year", () => {
  const hourly = pay(50, 55, "per-hour-wage");
  assert.deepEqual([hourly.min, hourly.max], [104000, 114400]);
  const r = scoreJob(job({ pay: hourly }), cfg, NOW);
  assert.equal(r.score, WEIGHTS.base + 15 - 25);
  assert.ok(r.why.includes("pay tops out under $120k"));
  assert.equal(scoreJob(job({ pay: pay(130000, 160000, "per-year-salary") }), cfg, NOW).score, WEIGHTS.base + 15);
});

test("a posting with no description says so, since the work-auth check had nothing to read", () => {
  assert.ok(scoreJob(job(), cfg, NOW).why.includes("description not read, so the work-auth check did not run"));
  assert.ok(!scoreJob(job({ text: "Python" }), cfg, NOW).why.some((w) => /not read/.test(w)));
});

test("Greenhouse's entity-encoded HTML decodes to text, and a printed pay range is read from it", () => {
  const text = htmlToText("&lt;p&gt;Build things&lt;/p&gt;&lt;p&gt;Pay: $165,000 &amp;#8211; $210,000&lt;/p&gt;");
  assert.equal(text, "Build things\nPay: $165,000 \u2013 $210,000");
  assert.deepEqual(payFromText(text), { min: 165000, max: 210000, text: "$165,000 \u2013 $210,000" });
  assert.deepEqual(payFromText("from $150k to $190k").min, 150000);
  assert.equal(payFromText("$45 - $60 an hour"), null, "an hourly range is not read as a year");
  assert.equal(payFromText("no pay printed"), null);
});
