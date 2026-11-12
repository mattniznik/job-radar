// The decisions: where a posting is, what kind of role it is, whether it is open to you, and
// how well it fits. Every function here is pure. The compiled config and the clock (`now`, in
// ms) come in as arguments, so the tests can pin both.
//
// The remote check is written for a US search: "remote" counts when it names the US or nothing
// at all, and the country and state lists below are US-centric. A search based elsewhere needs
// these lists changed.

const REMOTE = /\b(remote|anywhere|distributed)\b/i;
export const US_WORDS = /\b(united states|usa|u\.s\.a?\.?|us|america|north america)\b/i;
const US_STATE = /,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;
// After a comma, so a street like "W. Washington" is not read as the state.
const STATE_NAME =
  /,\s*(alabama|alaska|arizona|arkansas|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|wisconsin|wyoming)\b/i;
const US_CITY =
  /\b(san francisco|bay area|new york|nyc|seattle|austin|boston|chicago|denver|atlanta|miami|portland|san diego|san jose|los angeles|palo alto|mountain view|menlo park|sunnyvale|redmond|pittsburgh|philadelphia|dallas|houston|salt lake|phoenix|raleigh|minneapolis|nashville|washington)\b/i;
const NON_US =
  /\b(canada|toronto|vancouver|montr[eé]al|ontario|united kingdom|uk|england|london|ireland|dublin|europe|emea|european|germany|berlin|munich|france|paris|spain|madrid|barcelona|netherlands|amsterdam|poland|warsaw|india|bangalore|bengaluru|hyderabad|pune|singapore|japan|tokyo|australia|sydney|melbourne|brazil|s[aã]o paulo|mexico|latam|latin america|argentina|israel|tel aviv|apac|korea|seoul|china|switzerland|z[uü]rich|sweden|stockholm|denmark|copenhagen|portugal|lisbon|italy|milan|romania|czech|prague|costa rica|colombia|philippines|new zealand)\b/i;

// Boards join several places in one field: "A | B", "A; B", and Greenhouse's bullet (U+2022)
// between them, as in "San Francisco, CA <bullet> New York, NY <bullet> United States".
const SPLIT = /\s*[|;\u2022]\s*/;

/**
 * One location in your area? It names one of your places and either says your region
 * ("Oakland, CA"), or is a `bare` name that counts alone and sits beside no other state or
 * country. Most city names exist in more than one state ("Portland, ME").
 */
function isLocal(loc, L) {
  if (!L.places.test(loc)) return false;
  if (L.region.test(loc)) return true;
  return L.bare.test(loc) && !US_STATE.test(loc) && !STATE_NAME.test(loc) && !NON_US.test(loc);
}

/**
 * Where a posting is, or null when it is somewhere you cannot work from.
 *   local           one of its places is in your area (`preferred` scores higher)
 *   remote-us       remote with a US option
 *   remote-unclear  remote with no country at all: kept, but it is often a remote-in-Europe
 *                   role at a company based there, so it scores lower
 */
export function placeOf(locs, remoteFlag, L) {
  const text = [...new Set(locs.filter(Boolean))].join(" | ");
  const here = text.split(SPLIT).filter((l) => isLocal(l, L));
  if (here.length) return { kind: "local", preferred: here.some((l) => L.preferred.test(l)), text };
  if (!L.remote || !(remoteFlag === true || REMOTE.test(text))) return null;
  if (US_WORDS.test(text) || US_STATE.test(text) || US_CITY.test(text)) return { kind: "remote-us", text };
  if (NON_US.test(text)) return null;
  return { kind: "remote-unclear", text: text || "Remote" };
}

const OTHER = { name: "Other", tier: "maybe" };

/** The first `types` row whose regex matches the title. A title no row catches is a maybe, so nothing disappears unnoticed. */
export const typeOf = (title, cfg) => cfg.types.find((t) => t.re.test(title)) ?? OTHER;

/** The first profile whose titles match, or null for a skipped title or a `drop` type. */
export function profileOf(title, cfg) {
  if (cfg.skipTitles.test(title) || typeOf(title, cfg).tier === "drop") return null;
  return cfg.profiles.find((p) => p.titles.test(title))?.name ?? null;
}

/**
 * A fetched posting, kept when its title matches a profile and its place fits, with profile,
 * place, type and tier added. A title naming somewhere else ("Forward Deployed Engineer
 * (Atlanta, Georgia)", posted as remote) is a job based there, so it is dropped unless the
 * posting is local anyway.
 */
export function candidate(base, cfg) {
  const profile = profileOf(base.title, cfg);
  if (!profile) return null;
  const place = placeOf(base.locs ?? [], base.remote, cfg.location);
  if (!place) return null;
  if (place.kind !== "local" && (cfg.location.elsewhere.test(base.title) || (NON_US.test(base.title) && !US_WORDS.test(base.title)))) return null;
  const { name: type, tier } = typeOf(base.title, cfg);
  return { ...base, profile, place, type, tier };
}

/** The matched words with about 90 characters either side, so a false positive is visible in the report. */
export function around(text, m) {
  const a = Math.max(0, m.index - 90);
  return (a ? "…" : "") + text.slice(a, m.index + m[0].length + 90).replace(/\s+/g, " ").trim() + "…";
}

/**
 * Citizenship, residency, clearance and sponsorship. A `block` match moves the posting to Not
 * eligible; a `flag` match keeps it in its lane, marked red. Both carry the sentence.
 */
export function authCheck(text, cfg) {
  for (const { kind, re } of cfg.workAuth.block) {
    const m = re.exec(text ?? "");
    if (m) return { blocked: { kind, quote: around(text, m) }, flags: [] };
  }
  const flags = [];
  for (const { kind, re } of cfg.workAuth.flag) {
    const m = re.exec(text ?? "");
    if (m) flags.push({ kind, quote: around(text, m) });
  }
  return { blocked: null, flags };
}

/** The points, in one place so the README can quote them. */
export const WEIGHTS = {
  base: 10, // the title matched a profile, or the posting would not be here
  keyword: 8,
  keywordCap: 48,
  avoid: -5,
  avoidCap: -15,
  place: { preferred: 25, local: 15, "remote-us": 15, "remote-unclear": 5 },
  fresh: 5, // posted in the last 7 days
  stale: -10, // open more than 45 days
  veryStale: -20, // open more than 180 days: often an evergreen req
  underFloor: -25,
};

/**
 * Fit, 0 to 100, with the reasons. Keyword hits in the posting carry most of it; place and
 * age move it less, so a well-placed posting that says nothing about your work stays low.
 */
export function scoreJob(job, cfg, now) {
  const W = WEIGHTS;
  const p = cfg.profiles.find((x) => x.name === job.profile);
  const text = job.text ?? "";
  const why = [job.type];
  let s = W.base;

  const hits = p.keywords.filter(({ re }) => re.test(text)).map(({ term }) => term);
  s += Math.min(W.keywordCap, hits.length * W.keyword);
  const avoid = p.avoid.filter(({ re }) => re.test(text)).map(({ term }) => term);
  if (avoid.length) {
    s += Math.max(W.avoidCap, avoid.length * W.avoid);
    why.push(`asks for ${avoid.join(", ")}`);
  }

  const kind = job.place.kind === "local" && job.place.preferred ? "preferred" : job.place.kind;
  s += W.place[kind];
  why.push({ preferred: "preferred place", local: "local", "remote-us": "remote US", "remote-unclear": "remote, country not stated" }[kind]);

  const age = job.posted ? (now - Date.parse(job.posted)) / 864e5 : null;
  if (age !== null && !Number.isNaN(age)) {
    if (age <= 7) s += W.fresh;
    else if (age > 45) {
      s += age > 180 ? W.veryStale : W.stale;
      why.push(`posted ${Math.floor(age)} days ago`); // floor, as the report's Posted column does
    }
  }
  if (cfg.salaryFloor && job.pay?.max && job.pay.max < cfg.salaryFloor) {
    s += W.underFloor;
    why.push(`pay tops out under $${Math.round(cfg.salaryFloor / 1000)}k`);
  }
  // Not a score change, but the reader needs to know the work-auth check had nothing to read.
  if (!text) why.push("description not read, so the work-auth check did not run");
  return { score: Math.max(0, Math.min(100, s)), hits, why };
}
