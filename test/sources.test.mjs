// Each fetcher against its hand-written fixture, in the shape of that board's public API.
// `get` reads the fixtures folder, so nothing here touches the network.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { ashby, fixtureGet, greenhouse, hackernews, lever } from "../src/sources.mjs";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const cfg = loadConfig(new URL("../radar.example.yaml", import.meta.url));

/** fixtureGet, recording every URL asked for. */
function recording(fail = () => false) {
  const read = fixtureGet(FIXTURES);
  const urls = [];
  const get = async (url) => {
    urls.push(url);
    if (fail(url)) throw new Error("HTTP 500");
    return read(url);
  };
  return { get, urls };
}

const byTitle = (jobs) => Object.fromEntries(jobs.map((j) => [j.title, j]));

test("Greenhouse: a description is read only for titles that pass title and place, then decoded", async () => {
  const { get, urls } = recording();
  const r = await greenhouse("example-robotics", { get, cfg });
  assert.equal(r.total, 6);
  // Mechanical Engineer (no profile), the New York account executive (place) and the
  // platform role (a drop type) are never read.
  assert.deepEqual(urls.map((u) => u.split("/jobs")[1]), ["", "/1001", "/1002", "/1003"]);
  const fde = byTitle(r.jobs)["Forward Deployed Engineer"];
  assert.equal(fde.company, "Example Robotics");
  assert.match(fde.text, /Write Python and TypeScript services/);
  assert.doesNotMatch(fde.text, /&lt;|<li>/, "no tags or entities left");
  assert.deepEqual([fde.pay.min, fde.pay.max], [165000, 210000], "the range behind a numeric en dash entity");
  assert.deepEqual(fde.place, { kind: "local", preferred: true, text: "San Francisco, CA \u2022 New York, NY \u2022 United States | San Francisco, CA" });
  assert.equal(fde.applyVia, "Greenhouse");
});

test("Greenhouse: a description that fails to load keeps the row, with an empty text the score then names", async () => {
  const { get } = recording((u) => u.endsWith("/1001"));
  const fde = byTitle((await greenhouse("example-robotics", { get, cfg })).jobs)["Forward Deployed Engineer"];
  assert.equal(fde.text, "");
});

test("Lever: hourly pay becomes a year, a title naming another city is dropped, and the token is the company", async () => {
  const { get } = recording();
  const r = await lever("acme-analytics", { get, cfg });
  assert.equal(r.total, 5);
  const jobs = byTitle(r.jobs);
  assert.deepEqual(Object.keys(jobs).sort(), ["AI Solutions Engineer", "Account Executive", "Full Stack Engineer"]);
  assert.deepEqual([jobs["Full Stack Engineer"].pay.min, jobs["Full Stack Engineer"].pay.max], [104000, 114400]);
  assert.equal(jobs["AI Solutions Engineer"].place.kind, "remote-us");
  assert.match(jobs["AI Solutions Engineer"].text, /Build agents and RAG pipelines/, "the lists are part of the text");
  assert.equal(jobs["Account Executive"].company, "acme-analytics");
  assert.equal(jobs["Account Executive"].tier, "sales");
});

test("Ashby: unlisted and outside-the-US postings are skipped, compensation and HTML descriptions are read", async () => {
  const { get, urls } = recording();
  const r = await ashby("example-health", { get, cfg });
  assert.match(urls[0], /includeCompensation=true/);
  assert.equal(r.total, 5);
  const jobs = byTitle(r.jobs);
  assert.deepEqual(Object.keys(jobs).sort(), ["Forward Deployed Engineer", "Machine Learning Engineer", "Product Engineer"]);
  assert.deepEqual([jobs["Forward Deployed Engineer"].pay.min, jobs["Forward Deployed Engineer"].pay.max], [170000, 215000]);
  assert.match(jobs["Machine Learning Engineer"].text, /^Train and evaluate/, "descriptionHtml when there is no plain text");
  assert.equal(jobs["Machine Learning Engineer"].place.kind, "local");
});

test("Hacker News: the header gives company and role, the apply link is a careers link, never a news link", async () => {
  const { get } = recording();
  const r = await hackernews({ get, cfg });
  assert.equal(r.thread, "Ask HN: Who is hiring? (November 2026)");
  assert.equal(r.total, 5, "the deleted post has no text and is not counted");
  const jobs = Object.fromEntries(r.jobs.map((j) => [j.company, j]));
  // Quiet Harbor prices in euros and names no US option, so it is dropped.
  assert.deepEqual(Object.keys(jobs).sort(), ["Bright Kiln", "Example Health", "Granite Ledger", "Tiny Mill"]);
  assert.equal(jobs["Example Health"].applyUrl, "https://jobs.ashbyhq.com/example-health", "&#x2F; decoded");
  assert.equal(jobs["Example Health"].applyVia, "jobs.ashbyhq.com (from HN)");
  assert.equal(jobs["Tiny Mill"].title, "Founding Solutions Engineer");
  assert.equal(jobs["Tiny Mill"].applyVia, "HN post", "the only link was a news article");
  assert.deepEqual(jobs["Tiny Mill"].emails, ["jobs@tinymill.example"]);
  assert.equal(jobs["Tiny Mill"].place.kind, "local");
});

test("the fixture reader refuses a URL it has no route for, and a missing file answers like a 404", async () => {
  const get = fixtureGet(FIXTURES);
  await assert.rejects(get("https://example.com/jobs"), /no fixture route/);
  await assert.rejects(get("https://api.lever.co/v0/postings/no-such-board?mode=json"), /HTTP 404/);
});
