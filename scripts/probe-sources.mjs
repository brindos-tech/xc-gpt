// TEMPORARY probe #2 — removed before the PR.
const out = (label, v) => console.log(`\n===== ${label} =====\n${typeof v === "string" ? v : JSON.stringify(v, null, 1)}`.slice(0, 5000));
async function get(url) {
  try { const res = await fetch(url); const buf = Buffer.from(await res.arrayBuffer()); return { status: res.status, ct: res.headers.get("content-type"), size: buf.length, buf }; }
  catch (e) { return { status: "ERR", error: String(e) }; }
}
const j = (r) => { try { return JSON.parse(r.buf.toString()); } catch { return null; } };
const { execSync } = await import("node:child_process");
const fs = await import("node:fs");

let r = await get("https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/MTRSegment/FeatureServer/0?f=json");
out("MTRSegment meta", { status: r.status, name: j(r)?.name, geom: j(r)?.geometryType, fields: (j(r)?.fields || []).map((f) => f.name) });
r = await get("https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/MTRSegment/FeatureServer/0/query?where=1%3D1&outFields=*&resultRecordCount=3&returnGeometry=false&f=json");
out("MTRSegment sample", (j(r)?.features || []).map((f) => f.attributes));
r = await get("https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/MTRSegment/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json");
out("MTRSegment count", j(r));
r = await get("https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/MTRSegment/FeatureServer/0/query?where=1%3D1&outFields=*&resultRecordCount=1&outSR=4326&f=geojson");
out("MTRSegment geojson", { status: r.status, head: r.buf?.toString().slice(0, 1200) });
r = await get("https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Special_Use_Airspace/FeatureServer/0/query?where=TYPE_CODE%3D%27MOA%27&outFields=NAME&resultRecordCount=1&outSR=4326&f=geojson");
out("SUA geojson", { status: r.status, head: r.buf?.toString().slice(0, 800) });

const name = "29_Oct_2026";
for (const f of ["MTR_CSV.zip", "MIL_OPS_CSV.zip"]) {
  r = await get(`https://nfdc.faa.gov/webContent/28DaySub/extra/${name}_${f}`);
  out(`NASR ${f}`, { status: r.status, size: r.size });
  if (r.status === 200) {
    fs.mkdirSync(`/tmp/${f}`, { recursive: true });
    fs.writeFileSync(`/tmp/${f}/x.zip`, r.buf);
    console.log(execSync(`cd /tmp/${f} && unzip -o -q x.zip && ls -la && for c in *.csv; do echo "--- $c"; head -c 1500 "$c"; echo; done`).toString().slice(0, 9000));
  }
}
r = await get(`https://nfdc.faa.gov/webContent/28DaySub/extra/${name}_APT_CSV.zip`);
fs.writeFileSync("/tmp/apt.zip", r.buf);
console.log(execSync(`cd /tmp && unzip -o -q apt.zip && head -c 1200 APT_CON.csv; echo; grep -m2 '"END"\\|,"END",' APT_BASE.csv | head -c 3000; echo; awk -F'","' 'NR==1{for(i=1;i<=NF;i++) if($i ~ /FUEL_TYPES|CONTR_FUEL|OTHER_SERVICES|TWR_TYPE|LNDG_FEE|FACILITY_USE|OWNERSHIP/) print i, $i}' APT_BASE.csv; cut -d, -f1-3 APT_CSV_DATA_STRUCTURE.csv | head -3`).toString());
console.log(execSync(`cd /tmp && python3 - <<'PY'
import csv, collections
rows = list(csv.DictReader(open('/tmp/APT_BASE.csv', newline='', encoding='latin-1')))
c = collections.Counter(r['CONTR_FUEL_AVBL'] for r in rows); print('CONTR_FUEL_AVBL', c.most_common(6))
c = collections.Counter(r['FACILITY_USE_CODE'] for r in rows); print('FACILITY_USE', c.most_common(6))
c = collections.Counter(r['OWNERSHIP_TYPE_CODE'] for r in rows); print('OWNERSHIP', c.most_common(10))
c = collections.Counter(r['TWR_TYPE_CODE'] for r in rows); print('TWR', c.most_common(10))
ft = collections.Counter(t.strip() for r in rows for t in r['FUEL_TYPES'].split(',') if t.strip()); print('FUEL', ft.most_common(15))
os_ = collections.Counter(t.strip() for r in rows for t in r['OTHER_SERVICES'].split(',') if t.strip()); print('OTHER', os_.most_common(20))
for r in rows:
  if r['ARPT_ID'] in ('END','OKC','SWO','WDG','CBM','DLF','SPS','PNC'):
    print({k: r[k] for k in ('ARPT_ID','ICAO_ID','ARPT_NAME','CITY','COUNTY_NAME','STATE_CODE','FACILITY_USE_CODE','OWNERSHIP_TYPE_CODE','FUEL_TYPES','CONTR_FUEL_AVBL','TWR_TYPE_CODE','LNDG_FEE_FLAG','OTHER_SERVICES','TRNS_STRG_HGR_FLAG','PHONE_NO','MIL_LNDG_FLAG','JOINT_USE_FLAG')})
PY`).toString());

// Open-Meteo: how many locations per request?
for (const n of [100, 300, 600]) {
  const lat = Array.from({ length: n }, (_, i) => (30 + (i % 20) * 0.5).toFixed(2)).join(",");
  const lon = Array.from({ length: n }, (_, i) => (-100 + Math.floor(i / 20) * 0.5).toFixed(2)).join(",");
  r = await get(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_850hPa,relative_humidity_850hPa,cloud_cover_850hPa&forecast_days=8&timezone=UTC`);
  out(`open-meteo n=${n}`, { status: r.status, size: r.size, head: r.status !== 200 ? r.buf?.toString().slice(0, 300) : undefined });
}
