// Airspace layer definitions and the text shown for a clicked area/route.
// Data: data/generated/airspace-sua.json and airspace-mtr.json (FAA geometry
// + AP/1A/AP/1B scheduling details, see scripts/fetch-airspace.js).

export const AIRSPACE_LAYERS = [
  { key: "TFR", label: "TFRs", file: "tfr", match: (p) => p.type === "TFR", style: { color: "#ff3b6b", weight: 1.6, fillOpacity: 0.14, dashArray: "5,3" } },
  { key: "MOA", label: "MOAs", file: "sua", match: (p) => p.type === "MOA", style: { color: "#b98af0", weight: 1.2, fillOpacity: 0.07 } },
  { key: "R", label: "Restricted", file: "sua", match: (p) => p.type === "R", style: { color: "#e65a5a", weight: 1.2, fillOpacity: 0.09 } },
  { key: "W", label: "Warning", file: "sua", match: (p) => p.type === "W", style: { color: "#ff8a3d", weight: 1.2, fillOpacity: 0.06 } },
  { key: "A", label: "Alert", file: "sua", match: (p) => p.type === "A", style: { color: "#e8c15e", weight: 1.2, fillOpacity: 0.06 } },
  { key: "IR", label: "IR routes", file: "mtr", match: (p) => p.type === "IR", style: { color: "#5b8def", weight: 2, opacity: 0.85 } },
  { key: "VR", label: "VR routes", file: "mtr", match: (p) => p.type === "VR", style: { color: "#3ddc97", weight: 2, opacity: 0.85 } },
  { key: "SR", label: "SR routes", file: "mtr", match: (p) => p.type === "SR", style: { color: "#4fc3d9", weight: 2, opacity: 0.85, dashArray: "6,4" } },
];

export const DEFAULT_AIRSPACE = ["TFR", "MOA", "R", "W", "A"];

const TYPE_NAMES = { TFR: "Temporary Flight Restriction", MOA: "Military Operations Area", R: "Restricted Area", W: "Warning Area", A: "Alert Area", IR: "IFR Military Training Route", VR: "VFR Military Training Route", SR: "Slow-speed Low-altitude Training Route" };
export const typeName = (t) => TYPE_NAMES[t] || t;

/** Short hover text. */
export function airspaceTooltip(p) {
  if (p.type === "TFR") return `<b>${p.name}</b>${p.kind ? ` · ${p.kind}` : ""}${p.title ? `<br>${p.title}` : ""}`;
  if (p.type === "IR" || p.type === "VR" || p.type === "SR") return `<b>${p.name}</b>${p.altitudes ? ` · ${p.altitudes}` : ""}`;
  return `<b>${p.name}</b> · ${[p.bottom, p.top].filter(Boolean).join(" – ")}`;
}

/** Rows for the detail panel: [label, value] with nulls dropped. */
export function airspaceRows(p) {
  if (p.type === "TFR") return [["Type", p.kind], ["Where / when", p.title], ["State", p.state], ["Last changed (UTC)", p.modified ? `${p.modified.slice(0, 4)}-${p.modified.slice(4, 6)}-${p.modified.slice(6, 8)} ${p.modified.slice(8, 10)}:${p.modified.slice(10, 12)}` : null]].filter(([, v]) => v);
  const rows =
    p.type === "IR" || p.type === "VR" || p.type === "SR"
      ? [
          ["Altitudes", p.altitudes],
          ["Hours", p.hours || p.times],
          ["Width", p.width || p.widthText || (p.widthNm ? `${p.widthNm} NM total` : null)],
          ["Scheduling", p.scheduling || p.agencies?.find((a) => a.role === "Scheduling")?.name],
          ["Originating", p.originating || p.agencies?.find((a) => a.role === "Originating")?.name],
          ["Area", p.area],
        ]
      : [
          ["Altitudes", [p.bottom, p.top].filter(Boolean).join(" to ")],
          ["Times of use", p.times],
          ["Scheduling", p.scheduler ? `${p.scheduler.agency}, ${p.scheduler.location} — ${p.scheduler.phone}` : null],
          ["Using agency", p.sked],
          ["Activity", p.activity ? `ctc ${p.activity}` : null],
          ["Controlling", p.controlling],
          ["Near", p.near],
        ];
  return rows.filter(([, v]) => v);
}
