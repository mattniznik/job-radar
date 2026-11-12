// The HTML report: one self-contained page, no external assets. Pure: lanes and summary in,
// a string out.

import { money } from "./text.mjs";

const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ago = (d, now) => {
  if (!d) return "";
  const n = Math.floor((now - Date.parse(d)) / 864e5);
  return Number.isNaN(n) ? "" : n <= 0 ? "today" : `${n}d`;
};

function rows(list, lane, now) {
  return list
    .map((j) => {
      const chips = [
        ...(j.isNew ? [`<b class="new">NEW</b>`] : []),
        ...j.flags.map((f) => `<span class="flag" title="${h(f.quote)}">${h(f.kind)}: ${h(f.quote)}</span>`),
        ...j.why.map((w) => `<span class="why">${h(w)}</span>`),
        ...j.hits.slice(0, 8).map((k) => `<span class="kw">${h(k)}</span>`),
      ].join(" ");
      const last =
        lane === "blocked"
          ? `<td class="quote"><b>${h(j.blocked.kind)}</b>: ${h(j.blocked.quote)}</td>`
          : `<td><a href="${h(j.applyUrl)}">${h(j.applyVia)}</a>${j.alsoOn?.length ? `<br><small>also on ${h(j.alsoOn.join(", "))}</small>` : ""}${j.emails?.length ? `<br><small>${h(j.emails.join(", "))}</small>` : ""}</td>`;
      return `<tr data-new="${j.isNew ? 1 : 0}">
<td class="num">${j.score}</td>
<td><a href="${h(j.url)}"><b>${h(j.title)}</b></a><br><small>${h(j.company)} · ${h(j.place.text.slice(0, 90))}</small><div>${chips}</div></td>
<td>${h(j.profile)}</td><td>${money(j.pay)}</td><td>${ago(j.posted, now)}</td>${last}</tr>`;
    })
    .join("\n");
}

const sourceLine = ([k, v]) =>
  `${h(k)}: ${v.kept} kept of ${v.total}${v.thread ? ` (${h(v.thread)})` : ""}${v.failed?.length ? `, <b class="bad">${v.failed.length} failed</b> (${h(v.failed.join("; "))})` : ""}`;

/** The whole page. `now` (ms) dates the "posted" column, so a pinned clock gives the same page. */
export function render(lanes, summary, { minScore, now }) {
  const table = (list, lane, head) =>
    list.length
      ? `<table><thead><tr><th>Score</th><th>Role</th><th>Profile</th><th>Pay</th><th>Posted</th><th>${head}</th></tr></thead><tbody>${rows(list, lane, now)}</tbody></table>`
      : `<p class="none">Nothing in this lane.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>job-radar ${h(summary.date)}</title><style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px auto;max-width:1200px;padding:0 16px;color:#1b1b1b}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 6px}p.lead{color:#555;margin:0 0 6px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:7px 8px;border-bottom:1px solid #e6e6e6}
th{font-size:12px;color:#666;font-weight:600}td.num{font-weight:700;font-size:16px}small{color:#666}
a{color:#0b57d0;text-decoration:none}a:hover{text-decoration:underline}
span.kw,span.why,span.flag,b.new{display:inline-block;font-size:11px;padding:1px 6px;border-radius:9px;margin:3px 2px 0 0}
span.kw{background:#eef3fd;color:#2a4a8a}span.why{background:#f1f1f1;color:#444}span.flag{background:#fde8e8;color:#a11;max-width:520px}
b.new{background:#0b57d0;color:#fff}.bad{color:#a11}.none{color:#888}td.quote{font-size:12px;color:#555;max-width:520px}
.bar{position:sticky;top:0;background:#fff;padding:8px 0;border-bottom:1px solid #ddd;display:flex;gap:12px;align-items:center}
input[type=search]{flex:1;padding:6px 8px;font-size:14px}details{margin-top:24px}summary{cursor:pointer;font-weight:600}
</style></head><body>
<h1>job-radar - ${h(summary.date)}${summary.offline ? " (offline, from fixtures)" : ""}</h1>
<p class="lead">${summary.lanes.keep} matches at score ${minScore}+, ${summary.new} new, ${summary.lanes.sales} in Sales, ${summary.lanes.maybe} in Maybe. It finds and ranks only; nothing here has been applied to.</p>
<p class="lead"><small>${Object.entries(summary.sources).map(sourceLine).join("<br>")}</small></p>
<div class="bar"><input type="search" id="q" placeholder="Filter by title, company, keyword"><label><input type="checkbox" id="onlyNew"> new only</label></div>
<h2>Matches (${lanes.keep.length})</h2>
${table(lanes.keep, "keep", "Apply via")}
<h2>Sales, account management, business development (${lanes.sales.length})</h2>
<p class="lead">Kept apart so they do not bury the roles above.</p>
${table(lanes.sales, "sales", "Apply via")}
<details><summary>Maybe (${lanes.maybe.length})</summary>
${table(lanes.maybe, "maybe", "Apply via")}</details>
<details><summary>Not eligible: citizenship, residency, clearance or US-person status required (${lanes.blocked.length})</summary>
${table(lanes.blocked, "blocked", "Why, with the sentence that matched")}</details>
<p><small>${summary.below} more matched a profile but scored under ${minScore}. They are in jobs.json and the database, not here.</small></p>
<script>
const q=document.getElementById('q'),n=document.getElementById('onlyNew');
function f(){const t=q.value.toLowerCase();for(const r of document.querySelectorAll('tbody tr')){r.style.display=(!t||r.textContent.toLowerCase().includes(t))&&(!n.checked||r.dataset.new==='1')?'':'none'}}
q.oninput=f;n.onchange=f;
</script></body></html>`;
}
