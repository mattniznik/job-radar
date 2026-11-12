// Fetchers for public job-board APIs that need no key. Each takes a board token and
// `{ get, cfg }`, where `get(url)` returns parsed JSON: the network in a live run, the
// fixtures folder offline. Each returns { total, jobs }; `jobs` holds only candidates, a title
// that matched a profile at a place that fits (rules.mjs).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { candidate, US_WORDS } from "./rules.mjs";
import { decode, htmlToText, pay, payFromText } from "./text.mjs";

/** Greenhouse: the list carries no description, so filter on title and place first and read only the survivors. */
export async function greenhouse(token, { get, cfg }) {
  const base = `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`;
  const { jobs } = await get(base);
  const pre = jobs.filter((j) => candidate({ title: j.title, locs: [j.location?.name] }, cfg));
  // A detail that fails keeps the list row; the report then says its description was not read.
  const full = await pool(pre, 4, (j) => get(`${base}/${j.id}`).catch(() => j));
  return {
    total: jobs.length,
    jobs: full
      .map((j) => {
        const text = htmlToText(j.content ?? "");
        return candidate(
          {
            source: "greenhouse",
            id: `greenhouse:${token}:${j.id}`,
            company: j.company_name || token,
            title: j.title,
            locs: [j.location?.name, ...(j.offices ?? []).map((o) => o.location || o.name)],
            url: j.absolute_url,
            applyUrl: j.absolute_url,
            applyVia: "Greenhouse",
            posted: j.first_published ?? j.updated_at,
            pay: payFromText(text),
            text,
          },
          cfg,
        );
      })
      .filter(Boolean),
  };
}

/** Lever: one call with descriptions. The company name is not in the response, so the token stands in. */
export async function lever(token, { get, cfg }) {
  const jobs = await get(`https://api.lever.co/v0/postings/${token}?mode=json`);
  return {
    total: jobs.length,
    jobs: jobs
      .map((j) => {
        const text = [j.descriptionPlain, ...(j.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`), j.additionalPlain, j.salaryDescriptionPlain]
          .filter(Boolean)
          .join("\n");
        const c = j.categories ?? {};
        const r = j.salaryRange;
        return candidate(
          {
            source: "lever",
            id: `lever:${token}:${j.id}`,
            company: token,
            title: j.text,
            locs: [c.location, ...(c.allLocations ?? []), j.country === "US" ? "United States" : j.country],
            remote: j.workplaceType === "remote",
            url: j.hostedUrl,
            applyUrl: j.applyUrl ?? j.hostedUrl,
            applyVia: "Lever",
            posted: j.createdAt ? new Date(j.createdAt).toISOString() : null,
            pay: r ? pay(r.min, r.max, r.interval, j.salaryDescriptionPlain) : payFromText(text),
            text,
          },
          cfg,
        );
      })
      .filter(Boolean),
  };
}

/** Ashby: one call with descriptions and, when asked, compensation. Unlisted postings are skipped. */
export async function ashby(token, { get, cfg }) {
  const { jobs } = await get(`https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`);
  return {
    total: jobs.length,
    jobs: jobs
      .filter((j) => j.isListed !== false)
      .map((j) => {
        const comp = j.compensation ?? {};
        const parts = comp.summaryComponents?.length ? comp.summaryComponents : (comp.compensationTiers ?? []).flatMap((t) => t.components ?? []);
        const sal = parts.find((p) => p.compensationType === "Salary");
        const a = j.address?.postalAddress ?? {};
        const text = j.descriptionPlain ?? htmlToText(j.descriptionHtml);
        return candidate(
          {
            source: "ashby",
            id: `ashby:${token}:${j.id}`,
            company: token,
            title: j.title,
            locs: [j.location, ...(j.secondaryLocations ?? []).map((l) => l.location), [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(", ")],
            // workplaceType, not isRemote: some boards set isRemote on hybrid roles. A
            // "US - Remote" secondary location still counts, through the text.
            remote: j.workplaceType === "Remote",
            url: j.jobUrl,
            applyUrl: j.applyUrl ?? j.jobUrl,
            applyVia: "Ashby",
            posted: j.publishedAt,
            pay: sal ? pay(sal.minValue, sal.maxValue, sal.interval, comp.compensationTierSummary) : payFromText(text),
            text,
          },
          cfg,
        );
      })
      .filter(Boolean),
  };
}

const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return null;
  }
};

const HN_FIND =
  "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=%22Who%20is%20hiring%22&restrictSearchableAttributes=title&hitsPerPage=1";

/**
 * Hacker News "Ask HN: Who is hiring?", the newest monthly thread, read through the public
 * Algolia HN API. The first line of a post is its header, "Company (Remote US) | Role |
 * Location | ...", so the role is the first part of it that matches a profile.
 */
export async function hackernews({ get, cfg }) {
  const story = (await get(HN_FIND)).hits?.[0];
  if (!story) throw new Error("no Who is hiring thread found");
  const posts = (await get(`https://hn.algolia.com/api/v1/items/${story.objectID}`)).children.filter((c) => c.text);
  return {
    total: posts.length,
    thread: story.title,
    jobs: posts
      .map((c) => {
        const header = htmlToText(c.text.split(/<p>/i)[0]);
        const parts = header.split(/\s*\|\s*|\s+[\u2013\u2014]\s+/).map((p) => p.trim()).filter(Boolean);
        const title = parts.find((p) => candidate({ title: p, locs: [header] }, cfg));
        if (!title) return null;
        // "REMOTE | €70-90k" names no country, but the currency does.
        if (/[€£]/.test(header) && !/\b(us|usa|united states)\b/i.test(header)) return null;
        const text = htmlToText(c.text);
        // A careers or ATS link, not just the first link: the first is often a news article.
        // With none, the apply link is the post itself.
        const link = [...c.text.matchAll(/href="([^"]+)"/g)]
          .map((m) => decode(m[1]))
          .find((u) => !/ycombinator\.com/.test(u) && /job|career|apply|greenhouse|lever\.co|ashbyhq|workable|recruit|hiring|join/i.test(u));
        const post = `https://news.ycombinator.com/item?id=${c.id}`;
        return candidate(
          {
            source: "hn",
            id: `hn:${c.id}`,
            company: parts[0].replace(/\s*\([^)]*\)/g, "").trim(),
            title,
            locs: [header],
            url: post,
            applyUrl: link ?? post,
            applyVia: link ? `${hostOf(link)} (from HN)` : "HN post",
            posted: c.created_at,
            pay: payFromText(text),
            text,
            emails: [...new Set(text.match(/[\w.+-]+@[\w-]+\.[a-z.]{2,}/gi) ?? [])],
          },
          cfg,
        );
      })
      .filter(Boolean),
  };
}

export const BOARD_FETCHERS = { greenhouse, lever, ashby };

// ---------- I/O ----------

/** Run fn over items, n at a time. These are public APIs, so stay polite. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

/** GET JSON with a timeout. One retry, on a network error, 429 or 5xx only: a 404 will not fix itself. */
export async function getJson(url, { timeout = 30000 } = {}) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000));
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { Accept: "application/json" } });
    } catch (e) {
      last = e;
      continue;
    }
    if (res.ok) return res.json();
    last = new Error(`HTTP ${res.status}`);
    if (res.status < 500 && res.status !== 429) break;
  }
  throw last;
}

// Each API URL and the fixture file that stands in for it.
const ROUTES = [
  [/^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs\/(\d+)$/, (t, id) => join("greenhouse", t, `${id}.json`)],
  [/^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs$/, (t) => join("greenhouse", `${t}.json`)],
  [/^https:\/\/api\.lever\.co\/v0\/postings\/([^/?]+)/, (t) => join("lever", `${t}.json`)],
  [/^https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/([^/?]+)/, (t) => join("ashby", `${t}.json`)],
  [/^https:\/\/hn\.algolia\.com\/api\/v1\/search_by_date/, () => join("hn", "search.json")],
  [/^https:\/\/hn\.algolia\.com\/api\/v1\/items\/(\d+)$/, (id) => join("hn", `item-${id}.json`)],
];

/** A `get` that reads the fixtures folder instead of the network. A missing file answers like a 404. */
export function fixtureGet(dir) {
  return async (url) => {
    const route = ROUTES.find(([re]) => re.test(url));
    if (!route) throw new Error(`no fixture route for ${url}`);
    const file = join(dir, route[1](...url.match(route[0]).slice(1)));
    if (!existsSync(file)) throw new Error("HTTP 404");
    return JSON.parse(readFileSync(file, "utf8"));
  };
}

/** The boards the fixtures folder holds, in the shape of the config's `boards`. */
export function fixtureBoards(dir) {
  const tokens = (kind) =>
    existsSync(join(dir, kind))
      ? readdirSync(join(dir, kind))
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.slice(0, -5))
          .sort()
      : [];
  return { greenhouse: tokens("greenhouse"), lever: tokens("lever"), ashby: tokens("ashby") };
}
