// Draws forecast-grid layers as images that sit under the airspace on the
// planner map. Each image is rendered in Web-Mercator space (so it lines up
// with the basemap) and bilinear-smoothed between the 1° cells.
import { CAT_COLORS, flightCategory, NO_CEILING } from "./wx-model.js";

const PX_PER_CELL = 6;

const hex = (c, a) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), a];

/** Layer styles: which grid layers they need and how a sampled point is coloured (null = transparent). */
export const WX_STYLES = {
  cat: {
    needs: ["ceil", "vis"],
    color: (v) => {
      const c = flightCategory(Math.round(v.ceil), Math.round(v.vis));
      return c === 0 ? null : hex(CAT_COLORS[c], [0, 80, 105, 130][c]);
    },
  },
  lice: { needs: ["lice"], color: (v) => (v.lice < 0.35 ? null : [60, 200, 255, 60 + Math.min(1, v.lice / 2) * 120]) },
  hice: { needs: ["hice"], color: (v) => (v.hice < 0.35 ? null : [176, 120, 255, 60 + Math.min(1, v.hice / 2) * 120]) },
  ceil: {
    needs: ["ceil"],
    color: (v) => {
      const ft = v.ceil >= NO_CEILING ? Infinity : v.ceil * 100;
      return ft < 500 ? [214, 91, 224, 150] : ft < 1000 ? [230, 90, 90, 135] : ft < 2000 ? [255, 138, 61, 115] : ft <= 3000 ? [232, 193, 94, 95] : null;
    },
  },
  prec: {
    needs: ["prec"],
    color: (v) => {
      const mm = v.prec / 10;
      return mm < 0.1 ? null : mm < 1 ? [120, 220, 150, 95] : mm < 2.5 ? [60, 190, 90, 130] : mm < 7.6 ? [235, 210, 70, 150] : mm < 16 ? [255, 138, 61, 170] : [230, 70, 70, 185];
    },
  },
  thun: { needs: ["thun"], color: (v) => (v.thun < 0.5 ? null : [255, 60, 60, v.thun > 1.4 ? 175 : 115]) },
};

const mercY = (latDeg) => Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));
const latFromY = (y) => (Math.atan(Math.sinh(y)) * 180) / Math.PI;

/** Image bounds for a grid (cell centres sit on grid lines, so pad half a cell). */
export function gridBounds(g) {
  const h = g.step / 2;
  return [[g.lat0 - h, g.lon0 - h], [g.lat0 + (g.nlat - 1) * g.step + h, g.lon0 + (g.nlon - 1) * g.step + h]];
}

const pixelMaps = new WeakMap();

/** Per-pixel bilinear lookups, computed once per grid. */
function pixelMap(grid, cov) {
  if (pixelMaps.has(grid)) return pixelMaps.get(grid);
  const [[south, west], [north, east]] = gridBounds(grid);
  const W = grid.nlon * PX_PER_CELL;
  const y0 = mercY(south);
  const y1 = mercY(north);
  const H = Math.max(1, Math.round((W * (y1 - y0)) / (((east - west) * Math.PI) / 180)));
  const k00 = new Int32Array(W * H);
  const fx = new Float32Array(W * H);
  const fy = new Float32Array(W * H);
  for (let py = 0; py < H; py++) {
    const lat = latFromY(y1 - ((py + 0.5) / H) * (y1 - y0));
    const gy = (lat - grid.lat0) / grid.step;
    const r0 = Math.min(grid.nlat - 2, Math.max(0, Math.floor(gy)));
    for (let px = 0; px < W; px++) {
      const lon = west + ((px + 0.5) / W) * (east - west);
      const gx = (lon - grid.lon0) / grid.step;
      const c0 = Math.min(grid.nlon - 2, Math.max(0, Math.floor(gx)));
      const i = py * W + px;
      k00[i] = r0 * grid.nlon + c0;
      fy[i] = Math.min(1, Math.max(0, gy - r0));
      fx[i] = Math.min(1, Math.max(0, gx - c0));
    }
  }
  const m = { W, H, k00, fx, fy, cov, nlon: grid.nlon };
  pixelMaps.set(grid, m);
  return m;
}

/**
 * Render one style to a PNG data URL.
 * @param {object} grid index.grid
 * @param {Uint8Array} cov coverage mask
 * @param {Record<string, ArrayLike<number>>} layers grid values by layer name
 */
export function renderStyle(grid, cov, style, layers) {
  const m = pixelMap(grid, cov);
  const canvas = document.createElement("canvas");
  canvas.width = m.W;
  canvas.height = m.H;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(m.W, m.H);
  const v = {};
  for (let i = 0; i < m.W * m.H; i++) {
    const k = m.k00[i];
    const ks = [k, k + 1, k + m.nlon, k + m.nlon + 1];
    const x = m.fx[i];
    const y = m.fy[i];
    const ws = [(1 - y) * (1 - x), (1 - y) * x, y * (1 - x), y * x];
    let covered = 0;
    for (let j = 0; j < 4; j++) if (m.cov[ks[j]]) covered += ws[j];
    if (covered < 0.5) continue; // outside the fetched area
    for (const name of style.needs) {
      const a = layers[name];
      let sum = 0;
      for (let j = 0; j < 4; j++) if (m.cov[ks[j]]) sum += (name === "ceil" && a[ks[j]] >= NO_CEILING ? 400 : a[ks[j]]) * ws[j];
      v[name] = sum / covered;
    }
    const rgba = style.color(v);
    if (!rgba) continue;
    img.data[i * 4] = rgba[0];
    img.data[i * 4 + 1] = rgba[1];
    img.data[i * 4 + 2] = rgba[2];
    img.data[i * 4 + 3] = rgba[3];
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}
