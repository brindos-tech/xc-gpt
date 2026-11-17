// The Reviews tab: recent comments, the highest-rated fields/FBOs and
// airspace, and who has free food / a crew car / takes the AIR Card. Data
// comes from the comments API (/feed and /summary); everything is escaped.
import { esc } from "../planner/html.js";
import { formatUpdatedAgo, parseDate } from "../format.js";
import { subjectInfo, rankSubjects, filterFeed, PERKS } from "../planner/reviews.js";

const STAR = "★";
const SORTS = [
  ["recent", "Recent reviews"],
  ["top", "Top rated"],
  ["food", "Free food"],
  ["car", "Crew car"],
  ["card", "AIR Card accepted"],
];
const TYPES = [
  ["all", "Everything"],
  ["field", "Fields & FBOs"],
  ["air", "Airspace & routes"],
];
const STALE_MS = 60 * 1000;

const stars = (n) => `<span class="cm-stars" aria-label="${n} of 5">${STAR.repeat(n)}<i>${STAR.repeat(5 - n)}</i></span>`;
const tag = (label, v) => (v === "yes" ? `<span class="cm-tag ok">${label} ✓</span>` : v === "no" ? `<span class="cm-tag no">${label} ✗</span>` : "");

export function createReviewsPage({ root, store, apiBase, fieldsByCode }) {
  let data = null; // { feed, summary }
  let status = "idle"; // idle | loading | error
  let loadedAt = 0;

  if (!apiBase) root.innerHTML = `<p class="muted">Reviews aren't set up for this site.</p>`;

  async function load(force = false) {
    if (!apiBase || status === "loading") return;
    if (!force && data && Date.now() - loadedAt < STALE_MS) return;
    status = "loading";
    paint(store.getState());
    try {
      const [feed, summary] = await Promise.all([
        fetch(`${apiBase}/feed?limit=100`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
        fetch(`${apiBase}/summary`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
      ]);
      data = { feed: feed.comments || [], summary: summary.summary || {} };
      loadedAt = Date.now();
      status = "idle";
    } catch {
      status = "error";
    }
    paint(store.getState());
  }

  root.addEventListener("click", (e) => {
    const sort = e.target.closest("[data-rv-sort]");
    if (sort) return store.setState({ reviewsSort: sort.dataset.rvSort });
    const type = e.target.closest("[data-rv-type]");
    if (type) return store.setState({ reviewsType: type.dataset.rvType });
    if (e.target.closest("[data-rv-refresh]")) return load(true);
    const open = e.target.closest("[data-rv-open]");
    if (open) {
      const [kind, id] = [open.dataset.rvKind, open.dataset.rvOpen];
      store.setState(kind === "field" ? { view: "planner", selectedFieldId: id, selectedAirspaceId: null } : { view: "planner", selectedAirspaceId: id, selectedFieldId: null });
    }
  });

  function chips(attr, items, current) {
    return items.map(([key, label]) => `<button type="button" class="chip ${key === current ? "active" : ""}" data-rv-${attr}="${key}">${label}</button>`).join("");
  }

  function reviewCard(c) {
    const info = subjectInfo(c.subject, fieldsByCode);
    const facts = [
      c.fees && `<div><b>Fees:</b> ${esc(c.fees)}</div>`,
      c.planespotters && `<div><b>Planespotters:</b> ${esc(c.planespotters)}</div>`,
      c.amenities && `<div><b>Other amenities:</b> ${esc(c.amenities)}</div>`,
    ].filter(Boolean);
    const tags = [tag("Free food", c.freeFood), tag("Crew car", c.crewCar), tag("AIR Card", c.aircard)].join("");
    return `<li class="rv-card">
      <div class="rv-top"><button type="button" class="cm-link rv-title" data-rv-open="${esc(info.id)}" data-rv-kind="${info.kind}">${esc(info.title)}</button>${c.rating ? stars(c.rating) : ""}</div>
      ${info.sub ? `<div class="muted small">${esc(info.sub)}</div>` : ""}
      ${tags ? `<div class="cm-tags">${tags}</div>` : ""}
      ${facts.join("")}
      ${c.notes ? `<div class="cm-notes">${esc(c.notes)}</div>` : ""}
      <div class="muted small">${esc(c.name)}${c.visited ? ` · visited ${esc(parseDate(c.visited).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }))}` : ""} · posted ${esc(formatUpdatedAgo(c.createdAt))}</div>
    </li>`;
  }

  function rankRow(r, i, sort) {
    const perks = Object.entries(PERKS)
      .map(([k, label]) => {
        const [y, n] = r.perks[k] || [0, 0];
        return y || n ? `<span class="cm-tag ${y >= n ? "ok" : "no"}">${label}: ${y} yes${n ? `, ${n} no` : ""}</span>` : "";
      })
      .join("");
    return `<li class="rv-row">
      <span class="rv-rank">${i + 1}</span>
      <div class="rv-main"><button type="button" class="cm-link rv-title" data-rv-open="${esc(r.info.id)}" data-rv-kind="${r.info.kind}">${esc(r.info.title)}</button>
        ${r.info.sub ? `<div class="muted small">${esc(r.info.sub)}</div>` : ""}
        ${perks ? `<div class="cm-tags">${perks}</div>` : ""}</div>
      <div class="rv-score">${r.avg != null ? `<b>${STAR} ${r.avg}</b>` : `<span class="muted">no rating</span>`}<div class="muted small">${r.n} review${r.n === 1 ? "" : "s"}</div></div>
    </li>`;
  }

  function paint(state) {
    if (!apiBase) return;
    const sort = state.reviewsSort;
    const type = state.reviewsType;
    let body;
    if (status === "loading" && !data) body = `<p class="muted">Loading reviews…</p>`;
    else if (status === "error" && !data) body = `<p class="muted">Reviews are offline right now (the comments server isn't reachable). <button type="button" class="cm-link" data-rv-refresh>Retry</button></p>`;
    else if (!data) body = "";
    else if (sort === "recent") {
      const items = filterFeed(data.feed, fieldsByCode, { type, q: state.search });
      body = items.length ? `<ul class="rv-list">${items.map(reviewCard).join("")}</ul>` : `<p class="muted">${data.feed.length ? "Nothing matches that." : "No reviews yet. Open any field or airspace area and add the first one."}</p>`;
    } else {
      const rows = rankSubjects(data.summary, fieldsByCode, { sort, type, q: state.search });
      const note = sort === "top" ? "Ranked by average rating, adjusted for how many reviews there are." : `Fields where reviewers answered “yes” to ${PERKS[sort].toLowerCase()}.`;
      body = rows.length ? `<p class="muted small">${note}</p><ol class="rv-rank-list">${rows.map((r, i) => rankRow(r, i, sort)).join("")}</ol>` : `<p class="muted">${Object.keys(data.summary).length ? "Nothing here yet." : "No reviews yet. Open any field or airspace area and add the first one."}</p>`;
    }
    root.innerHTML = `<div class="rv-head"><h2>Reviews</h2><span class="muted small">from crews who've been there</span><button type="button" class="chip" data-rv-refresh>${status === "loading" ? "Refreshing…" : "Refresh"}</button></div>
      <div class="chip-row rv-chips" role="group" aria-label="Show">${chips("sort", SORTS, sort)}</div>
      <div class="chip-row rv-chips" role="group" aria-label="Limit to">${chips("type", TYPES, type)}</div>
      ${body}`;
  }

  return {
    render(state) {
      load();
      paint(state);
    },
  };
}
