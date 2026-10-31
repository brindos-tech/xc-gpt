// Everything the planner shows comes from data files (the nav info list,
// FLIP text, FAA records) — escape it before it goes into innerHTML.
const MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => MAP[c]);
