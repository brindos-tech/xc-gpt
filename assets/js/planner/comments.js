// Public comments on a field/FBO or an airspace area/route, backed by the
// Fly API in server/. The section lives in its own host element beside the
// field sheet's content, so the sheet re-rendering (weather, trip date…)
// never wipes a half-written comment. All comment text is escaped; the server
// also rejects links.
import { esc } from "./html.js";
import { parseDate, formatUpdatedAgo } from "../format.js";

const STAR = "★";

/** { "field:KOKC": { n, avg } } for every subject with comments; {} if the API is unreachable. */
export async function loadCommentSummary(apiBase) {
  if (!apiBase) return {};
  try {
    const res = await fetch(`${apiBase}/summary`);
    return res.ok ? (await res.json()).summary || {} : {};
  } catch {
    return {};
  }
}
const TRI = [["", "—"], ["yes", "Yes"], ["no", "No"]];
const tag = (label, v) => (v === "yes" ? `<span class="cm-tag ok">${label} ✓</span>` : v === "no" ? `<span class="cm-tag no">${label} ✗</span>` : "");

const visitedText = (iso) => {
  const d = parseDate(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

function commentHtml(c) {
  const stars = c.rating ? `<span class="cm-stars" aria-label="${c.rating} of 5">${STAR.repeat(c.rating)}<i>${STAR.repeat(5 - c.rating)}</i></span>` : "";
  const facts = [
    c.fees && `<div><b>Fees:</b> ${esc(c.fees)}</div>`,
    c.planespotters && `<div><b>Planespotters:</b> ${esc(c.planespotters)}</div>`,
    c.amenities && `<div><b>Other amenities:</b> ${esc(c.amenities)}</div>`,
  ].filter(Boolean);
  return `<li class="cm-item">
    <div class="cm-head"><b>${esc(c.name)}</b>${stars}<span class="muted small">${c.visited ? `visited ${esc(visitedText(c.visited))} · ` : ""}posted ${esc(formatUpdatedAgo(c.createdAt))}</span></div>
    ${[tag("Free food", c.freeFood), tag("Crew car", c.crewCar), tag("AIR Card", c.aircard)].join("") ? `<div class="cm-tags">${tag("Free food", c.freeFood)}${tag("Crew car", c.crewCar)}${tag("AIR Card", c.aircard)}</div>` : ""}
    ${facts.join("")}
    ${c.notes ? `<div class="cm-notes">${esc(c.notes)}</div>` : ""}
  </li>`;
}

const select = (name, label) => `<label>${label}<select name="${name}">${TRI.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></label>`;

function reportFormHtml(label) {
  return `<form class="cm-form cm-report" novalidate hidden data-kind="report">
    <div class="muted small">Something wrong or out of date for ${esc(label)}? This goes to the site owner only — it isn't posted publicly.</div>
    <label>What's wrong?<textarea name="notes" rows="3" maxlength="1500" placeholder="e.g. FBO phone number changed to…, fuel is no longer available, hours are wrong"></textarea></label>
    <label>Your name (optional)<input name="name" maxlength="40" autocomplete="nickname"></label>
    <div class="cm-hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
    <div class="cm-actions"><button type="submit" class="cm-post">Send report</button><span class="cm-status" role="status"></span></div>
  </form>`;
}

function formHtml(isField, today) {
  const nameValue = (() => {
    try {
      return localStorage.getItem("xcgpt-name") || "";
    } catch {
      return "";
    }
  })();
  return `<form class="cm-form" novalidate hidden>
    <fieldset class="cm-rating"><legend>Rating</legend>
      ${[1, 2, 3, 4, 5].map((n) => `<label><input type="radio" name="rating" value="${n}"><span aria-label="${n} star${n > 1 ? "s" : ""}">${STAR}</span></label>`).join("")}
      <button type="button" class="cm-clear" data-clear-rating>clear</button>
    </fieldset>
    ${
      isField
        ? `<div class="cm-grid">${select("freeFood", "Free food?")}${select("crewCar", "Crew car?")}${select("aircard", "AIR Card accepted?")}</div>
    <label>Fees<input name="fees" maxlength="200" placeholder="ramp, handling, overnight, landing…"></label>
    <label>Planespotters<input name="planespotters" maxlength="300" placeholder="what's parked, where to watch from…"></label>
    <label>Other amenities<input name="amenities" maxlength="300" placeholder="lounge, coffee, showers, courtesy hotel…"></label>`
        : ""
    }
    <label>${isField ? "Date visited" : "Date flown"}<input type="date" name="visited" max="${today}"></label>
    <label>Notes<textarea name="notes" rows="4" maxlength="1500" placeholder="${isField ? "How was the FBO? Fuel, service, tie-downs, hours…" : "Activity, hot/cold, controllers, hazards, how it flew…"}"></textarea></label>
    <label>Your name (optional)<input name="name" maxlength="40" value="${esc(nameValue)}" autocomplete="nickname"></label>
    <div class="cm-hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
    <div class="cm-actions"><button type="submit" class="cm-post">Post comment</button><span class="cm-status" role="status"></span></div>
    <div class="muted small">Public. No links. Be useful and be nice; the owner can remove comments.</div>
  </form>`;
}

export function createComments({ host, apiBase, today = new Date() }) {
  if (!apiBase) {
    host.hidden = true;
    return { show() {}, enabled: false };
  }
  let subject = null;
  let label = "";
  let comments = [];
  let status = "idle"; // idle | loading | error
  let openedAt = 0;
  let seq = 0;
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  host.addEventListener("click", (e) => {
    const openBtn = e.target.closest("[data-cm-open]");
    if (openBtn) {
      const form = host.querySelector(openBtn.dataset.cmOpen === "report" ? ".cm-report" : ".cm-form:not(.cm-report)");
      form.hidden = !form.hidden;
      if (!form.hidden) {
        openedAt = Date.now();
        host.querySelectorAll(".cm-form").forEach((f) => f !== form && (f.hidden = true));
      }
      openBtn.setAttribute("aria-expanded", String(!form.hidden));
    } else if (e.target.closest("[data-clear-rating]")) {
      host.querySelectorAll('input[name="rating"]').forEach((r) => (r.checked = false));
    } else if (e.target.closest("[data-cm-retry]")) {
      load();
    }
  });
  host.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = Object.fromEntries(new FormData(form));
    const msg = form.querySelector(".cm-status");
    const btn = form.querySelector(".cm-post");
    btn.disabled = true;
    msg.textContent = "Posting…";
    try {
      const res = await fetch(`${apiBase}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, subject, kind: form.dataset.kind === "report" ? "report" : "comment", elapsedMs: Date.now() - openedAt }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Couldn't post (${res.status}).`);
      const isReport = form.dataset.kind === "report";
      if (!isReport && body.comment?.id && body.comment.id !== "ok") comments = [body.comment, ...comments];
      try {
        if (data.name) localStorage.setItem("xcgpt-name", data.name);
      } catch {
        // storage blocked
      }
      form.reset();
      form.querySelector('[name="name"]').value = data.name || "";
      form.hidden = true;
      host.querySelectorAll("[data-cm-open]").forEach((b) => b.setAttribute("aria-expanded", "false"));
      renderList();
      msg.textContent = "";
      if (isReport) {
        const note = host.querySelector(".cm-thanks");
        note.textContent = "Thanks — the owner will see your report.";
        setTimeout(() => (note.textContent = ""), 6000);
      }
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  function renderList() {
    const box = host.querySelector(".cm-list");
    if (!box) return;
    if (status === "loading") box.innerHTML = `<div class="muted small">Loading comments…</div>`;
    else if (status === "error") box.innerHTML = `<div class="muted small">Comments are offline right now. <button type="button" class="cm-link" data-cm-retry>Retry</button></div>`;
    else if (!comments.length) box.innerHTML = `<div class="muted small">No comments yet. Be the first.</div>`;
    else {
      const rated = comments.filter((c) => c.rating);
      const avg = rated.length ? (rated.reduce((s, c) => s + c.rating, 0) / rated.length).toFixed(1) : null;
      box.innerHTML = `<div class="cm-summary">${avg ? `<b>${STAR} ${avg}</b> · ` : ""}${comments.length} comment${comments.length === 1 ? "" : "s"}</div><ul class="cm-items">${comments.map(commentHtml).join("")}</ul>`;
    }
  }

  async function load() {
    const mine = ++seq;
    status = "loading";
    comments = [];
    renderList();
    try {
      const res = await fetch(`${apiBase}/comments?subject=${encodeURIComponent(subject)}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      if (mine !== seq) return; // the user moved on
      comments = body.comments || [];
      status = "idle";
    } catch {
      if (mine !== seq) return;
      status = "error";
    }
    renderList();
  }

  /** Show comments for `next` ({ subject, label }) or hide the section (null). */
  function show(next) {
    const key = next?.subject || null;
    if (key === subject) return;
    subject = key;
    seq++;
    if (!key) {
      host.innerHTML = "";
      host.hidden = true;
      return;
    }
    label = next.label;
    host.hidden = false;
    host.innerHTML = `<h4>Comments · ${esc(label)}</h4>
      <div class="cm-list"></div>
      <div class="cm-buttons">
        <button type="button" class="cm-open" data-cm-open="comment" aria-expanded="false">Add a comment</button>
        <button type="button" class="cm-link" data-cm-open="report" aria-expanded="false">Report a problem</button>
        <span class="cm-thanks muted small" role="status"></span>
      </div>
      ${formHtml(key.startsWith("field:"), todayKey)}
      ${reportFormHtml(label)}`;
    load();
  }

  return { show, enabled: true };
}
