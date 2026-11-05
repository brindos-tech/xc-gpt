// Everything the planner shows comes from data files (the nav info list,
// FLIP text, FAA records) — escape it before it goes into innerHTML.
const MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => MAP[c]);

/** A link target the page may open: web addresses only (no javascript:, data: and so on); "" otherwise. */
export const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? "").trim()) ? String(u).trim() : "");
