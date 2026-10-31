// TEMPORARY: samples each candidate data source so parsers can be written
// against real responses. Deleted before the PR.
const out = (label, v) => console.log(`\n===== ${label} =====\n${typeof v === "string" ? v : JSON.stringify(v, null, 1)}`.slice(0, 6000));
async function get(url, opts = {}) {
  try {
    const res = await fetch(url, opts);
    const ct = res.headers.get("content-type") || "";
    const acao = res.headers.get("access-control-allow-origin");
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, ct, acao, size: buf.length, buf };
  } catch (e) {
    return { status: "ERR", error: String(e) };
  }
}
const j = (r) => { try { return JSON.parse(r.buf.toString()); } catch { return null; } };

// ---- ArcGIS org services (FAA ADDS)
let r = await get("https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services?f=json");
out("arcgis services", { status: r.status, services: (j(r)?.services || []).map((s) => `${s.name} (${s.type})`) });
for (const svc of ["Special_Use_Airspace", "Military_Training_Routes", "US_Airport", "Runways"]) {
  r = await get(`https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/${svc}/FeatureServer/0?f=json`);
  const meta = j(r);
  out(`${svc} layer meta`, { status: r.status, name: meta?.name, geom: meta?.geometryType, maxRecordCount: meta?.maxRecordCount, fields: (meta?.fields || []).map((f) => f.name) });
  r = await get(`https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/${svc}/FeatureServer/0/query?where=1%3D1&outFields=*&resultRecordCount=2&returnGeometry=false&f=json`);
  out(`${svc} sample`, { status: r.status, features: (j(r)?.features || []).map((f) => f.attributes) });
  r = await get(`https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/${svc}/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json`);
  out(`${svc} count`, j(r));
}
r = await get("https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Special_Use_Airspace/FeatureServer/0/query?where=1%3D1&outFields=TYPE_CODE&returnDistinctValues=true&returnGeometry=false&f=json");
out("SUA distinct TYPE_CODE", (j(r)?.features || []).map((f) => f.attributes));
r = await get("https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Military_Training_Routes/FeatureServer/0/query?where=1%3D1&outFields=*&resultRecordCount=1&returnGeometry=true&outSR=4326&f=geojson");
out("MTR geojson sample", { status: r.status, size: r.size, head: r.buf?.toString().slice(0, 1500) });

// ---- NASR 28-day APT CSV
const cycle = (d) => { const base = Date.UTC(2024, 0, 25); const n = Math.floor((d - base) / 86400000 / 28); return new Date(base + n * 28 * 86400000); };
const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
for (const back of [0, 1]) {
  const c = cycle(Date.now() - back * 28 * 86400000);
  const name = `${String(c.getUTCDate()).padStart(2, "0")}_${mon[c.getUTCMonth()]}_${c.getUTCFullYear()}_APT_CSV.zip`;
  r = await get(`https://nfdc.faa.gov/webContent/28DaySub/extra/${name}`);
  out(`NASR ${name}`, { status: r.status, ct: r.ct, size: r.size });
  if (r.status === 200) {
    const fs = await import("node:fs");
    fs.writeFileSync("/tmp/apt.zip", r.buf);
    const { execSync } = await import("node:child_process");
    console.log(execSync("cd /tmp && unzip -o -q apt.zip && ls -la /tmp/*.csv | head -30").toString());
    for (const f of ["APT_BASE.csv", "APT_RWY.csv", "APT_ATT.csv"]) {
      try { console.log(`--- ${f}\n` + execSync(`head -c 2500 /tmp/${f}`).toString()); } catch (e) { console.log(f, "missing"); }
    }
    console.log(execSync(`grep -m3 '"END"' /tmp/APT_BASE.csv || true`).toString());
    break;
  }
}

// ---- Open-Meteo multi-location, pressure levels, 8 days
const lats = [36.34, 33.6, 29.36, 33.99].join(",");
const lons = [-97.92, -88.44, -100.78, -98.49].join(",");
const lv = [925, 850, 700, 600, 500, 400];
const vars = ["visibility", "cloud_cover_low", "precipitation", "weather_code", "cape", "freezing_level_height",
  ...lv.flatMap((p) => [`temperature_${p}hPa`, `relative_humidity_${p}hPa`, `cloud_cover_${p}hPa`, `geopotential_height_${p}hPa`])];
r = await get(`https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=${vars.join(",")}&forecast_days=8&timezone=UTC`);
const om = j(r);
out("open-meteo multi", { status: r.status, size: r.size, isArray: Array.isArray(om), n: Array.isArray(om) ? om.length : null,
  keys: Array.isArray(om) ? Object.keys(om[0].hourly) : om, len: Array.isArray(om) ? om[0].hourly.time.length : null,
  vis: Array.isArray(om) ? om[0].hourly.visibility.slice(0, 5).concat(om[0].hourly.visibility.slice(-5)) : null,
  cc850: Array.isArray(om) ? om[0].hourly.cloud_cover_850hPa.slice(150, 160) : null });

// ---- radar tiles
for (const u of ["https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/5/7/12.png",
  "https://api.rainviewer.com/public/weather-maps.json"]) {
  r = await get(u, { headers: { Origin: "https://brindos-tech.github.io" } });
  out(`radar ${u}`, { status: r.status, ct: r.ct, acao: r.acao, size: r.size, head: r.ct.includes("json") ? r.buf.toString().slice(0, 600) : undefined });
}

// ---- aviationweather METAR (CORS check)
r = await get("https://aviationweather.gov/api/data/metar?ids=KEND,KOKC&format=json", { headers: { Origin: "https://brindos-tech.github.io" } });
out("awc metar", { status: r.status, acao: r.acao, head: r.buf?.toString().slice(0, 700) });

// ---- GSA per diem
for (const u of ["https://api.gsa.gov/travel/perdiem/v2/rates/conus/lodging/2027?api_key=DEMO_KEY",
  "https://api.gsa.gov/travel/perdiem/v2/rates/conus/mie/2027?api_key=DEMO_KEY",
  "https://api.gsa.gov/travel/perdiem/v2/rates/city/Enid/state/OK/year/2027?api_key=DEMO_KEY"]) {
  r = await get(u);
  const d = j(r);
  out(`gsa ${u.split("/v2/")[1]}`, { status: r.status, size: r.size, sample: Array.isArray(d) ? d.slice(0, 2) : d });
}
