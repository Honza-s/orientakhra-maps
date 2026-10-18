// Vyrobí herní mapu z otevřených dat: lidar ČÚZK (DMR 5G + DMP 1G) + OpenStreetMap.
//
//   npm run build-map -- --id krcsky-les --name "Hrádek – Krčský les" --place "Praha 4" \
//        --bbox 50.013,14.451,50.040,14.493
//
// Bez --out se mapa uloží do maps/<id>/ a zapíše (nebo aktualizuje) v catalog.json.
//
// Výstup (vše v lokální síti UTM 33N, x = východ, y = sever, 1 jednotka = 1 m):
//   meta.json      rozměry, původ, výškový rozsah, popis vrstev
//   terrain.png    2 m/px; R,G = výška (cm nad hmin, 16 bit), B = výška porostu (0,25 m)
//   cover.png      1 m/px; R = typ povrchu (viz COVER v src/game/cover.ts)
//   map.webp       orienťácká mapa 1:10 000, MAP_PX_PER_M px/m
//   ground.webp    barva země pro 3D, 1 px/m
//   features.json  kandidáti na kontroly (kupky, prohlubně, křižovatky…)
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import proj4 from 'proj4';
import Delaunator from 'delaunator';
import { unzipSync } from 'fflate';
import { contours as d3contours } from 'd3-contour';
import { createCanvas } from '@napi-rs/canvas';
import { readLaz } from './lib/laz.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, 'cache');
mkdirSync(CACHE, { recursive: true });

// ---------- argumenty ----------
const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []),
);
const [lat1, lon1, lat2, lon2] = args.bbox.split(',').map(Number);
const ID = args.id;
const NAME = args.name ?? ID;
const OUT = args.out ?? join(HERE, '..', 'maps', ID);
mkdirSync(OUT, { recursive: true });
const log = (...m) => console.log(`[${((performance.now()) / 1000).toFixed(1)}s]`, ...m);

// ---------- souřadnice ----------
proj4.defs('EPSG:5514', '+proj=krovak +lat_0=49.5 +lon_0=24.83333333333333 +alpha=30.28813972222222 +k=0.9999 +x_0=0 +y_0=0 +ellps=bessel +towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56 +units=m +no_defs');
proj4.defs('EPSG:32633', '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs');
const toUtm = proj4('EPSG:4326', 'EPSG:32633');
const jtskToUtm = proj4('EPSG:5514', 'EPSG:32633');

const corners = [[lon1, lat1], [lon2, lat1], [lon1, lat2], [lon2, lat2]].map((c) => toUtm.forward(c));
const E0 = Math.floor(Math.min(...corners.map((c) => c[0])) / 10) * 10;
const N0 = Math.floor(Math.min(...corners.map((c) => c[1])) / 10) * 10;
const W = Math.ceil((Math.max(...corners.map((c) => c[0])) - E0) / 10) * 10; // m
const H = Math.ceil((Math.max(...corners.map((c) => c[1])) - N0) / 10) * 10; // m
log(`oblast ${W} × ${H} m, UTM původ ${E0}/${N0}`);
// lokální: x = E - E0, y = N - N0 ; rastrový řádek r = H-1-y (sever nahoře)

const fromWgs = ([lon, lat]) => { const [e, n] = toUtm.forward([lon, lat]); return [e - E0, n - N0]; };

// ---------- stažení lidaru ----------
async function cached(name, url, opts) {
  const p = join(CACHE, name);
  if (existsSync(p)) return readFileSync(p);
  log('stahuji', url);
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  writeFileSync(p, b);
  return b;
}

async function sheetsFor() {
  const xml = (await cached('DMR5G-feed.xml', 'https://atom.cuzk.gov.cz/DMR5G-SJTSK/DMR5G-SJTSK.xml')).toString('utf8');
  const out = [];
  const m = 0.004; // okraj ve stupních
  for (const ent of xml.split('<entry>').slice(1)) {
    const poly = /<georss:polygon>([^<]*)/.exec(ent)?.[1];
    const id = /_DMR5G-SJTSK_([A-Z0-9]+)\.xml/.exec(ent)?.[1];
    if (!poly || !id) continue;
    const n = poly.trim().split(/\s+/).map(Number);
    const la = n.filter((_, i) => i % 2 === 0), lo = n.filter((_, i) => i % 2 === 1);
    if (Math.max(...la) > lat1 - m && Math.min(...la) < lat2 + m && Math.max(...lo) > lon1 - m && Math.min(...lo) < lon2 + m) out.push(id);
  }
  return out;
}

async function loadPoints(kind, sheet) {
  const zip = await cached(`${kind}_${sheet}.zip`, `https://openzu.cuzk.gov.cz/opendata/${kind}/epsg-5514/${sheet}.zip`);
  const lazPath = join(CACHE, `${kind}_${sheet}.laz`);
  if (!existsSync(lazPath)) {
    const files = unzipSync(new Uint8Array(zip));
    const name = Object.keys(files).find((f) => f.toLowerCase().endsWith('.laz'));
    writeFileSync(lazPath, files[name]);
  }
  return readLaz(lazPath);
}

// převod a ořez bodů do lokálních souřadnic (s okrajem 60 m kvůli TIN)
function localize(p, keep) {
  const xs = [], ys = [], zs = [], cs = [];
  const M = 60;
  for (let i = 0; i < p.count; i++) {
    if (keep && !keep(p.cls[i])) continue;
    const [e, n] = jtskToUtm.forward([p.x[i], p.y[i]]);
    const x = e - E0, y = n - N0;
    if (x < -M || y < -M || x > W + M || y > H + M) continue;
    xs.push(x); ys.push(y); zs.push(p.z[i]); cs.push(p.cls[i]);
  }
  return { x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float32Array.from(zs), cls: Uint8Array.from(cs) };
}
const concat = (parts, k, T) => { const out = new T(parts.reduce((s, p) => s + p[k].length, 0)); let o = 0; for (const p of parts) { out.set(p[k], o); o += p[k].length; } return out; };
const merge = (parts) => ({ x: concat(parts, 'x', Float64Array), y: concat(parts, 'y', Float64Array), z: concat(parts, 'z', Float32Array), cls: concat(parts, 'cls', Uint8Array) });

// ---------- TIN → rastr ----------
// grid: res m/px, w×h, řádek 0 = sever
function rasterizeTin(pts, res) {
  const w = Math.round(W / res), h = Math.round(H / res);
  const out = new Float32Array(w * h).fill(NaN);
  const coords = new Float64Array(pts.x.length * 2);
  for (let i = 0; i < pts.x.length; i++) { coords[2 * i] = pts.x[i]; coords[2 * i + 1] = pts.y[i]; }
  const tri = new Delaunator(coords).triangles;
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    const ax = pts.x[a] / res, ay = (H - pts.y[a]) / res, bx = pts.x[b] / res, by = (H - pts.y[b]) / res, cx = pts.x[c] / res, cy = (H - pts.y[c]) / res;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
    if (minX > maxX || minY > maxY) continue;
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-12) continue;
    for (let py = minY; py <= maxY; py++) {
      const sy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const sx = px + 0.5;
        const l1 = ((by - cy) * (sx - cx) + (cx - bx) * (sy - cy)) / d;
        const l2 = ((cy - ay) * (sx - cx) + (ax - cx) * (sy - cy)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
        out[py * w + px] = l1 * pts.z[a] + l2 * pts.z[b] + l3 * pts.z[c];
      }
    }
  }
  // díry (mimo TIN) doplnit nejbližším sousedem po řádcích
  for (let i = 0; i < out.length; i++) if (Number.isNaN(out[i])) out[i] = i > 0 ? out[i - 1] : 0;
  return { data: out, w, h, res };
}

function blur(src, w, h, radius) {
  // dvojitý box blur ≈ gauss
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      let s = 0, n = 0;
      for (let x = -radius; x < w + radius; x++) {
        if (x + radius < w && x + radius >= 0) { s += a[y * w + x + radius]; n++; }
        if (x - radius - 1 >= 0) { s -= a[y * w + x - radius - 1]; n--; }
        if (x >= 0 && x < w) b[y * w + x] = s / n;
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let y = -radius; y < h + radius; y++) {
        if (y + radius < h && y + radius >= 0) { s += b[(y + radius) * w + x]; n++; }
        if (y - radius - 1 >= 0) { s -= b[(y - radius - 1) * w + x]; n--; }
        if (y >= 0 && y < h) a[y * w + x] = s / n;
      }
    }
  }
  return a;
}

function downsample(g, f) {
  const w = Math.floor(g.w / f), h = Math.floor(g.h / f), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) s += g.data[(y * f + j) * g.w + x * f + i];
    out[y * w + x] = s / (f * f);
  }
  return { data: out, w, h, res: g.res * f };
}

// ---------- OSM ----------
async function loadOsm() {
  const q = `[out:json][timeout:180];(way(${lat1 - 0.003},${lon1 - 0.004},${lat2 + 0.003},${lon2 + 0.004});relation["type"="multipolygon"](${lat1 - 0.003},${lon1 - 0.004},${lat2 + 0.003},${lon2 + 0.004});node["natural"~"stone|spring|tree|peak"](${lat1},${lon1},${lat2},${lon2});node["historic"](${lat1},${lon1},${lat2},${lon2});node["man_made"](${lat1},${lon1},${lat2},${lon2}););out geom;`;
  const buf = await cached(`osm_${ID}.json`, 'https://overpass-api.de/api/interpreter', {
    method: 'POST', headers: { 'User-Agent': 'orientakhra-pipeline/0.1', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q),
  });
  const j = JSON.parse(buf.toString('utf8'));
  const ways = [], rels = [], nodes = [];
  for (const e of j.elements) {
    if (e.type === 'way' && e.geometry) ways.push({ tags: e.tags ?? {}, pts: e.geometry.map((g) => fromWgs([g.lon, g.lat])), closed: e.nodes?.[0] === e.nodes?.at(-1) });
    else if (e.type === 'relation') rels.push({ tags: e.tags ?? {}, rings: (e.members ?? []).filter((m) => m.geometry && m.type === 'way').map((m) => ({ role: m.role, pts: m.geometry.map((g) => fromWgs([g.lon, g.lat])) })) });
    else if (e.type === 'node') nodes.push({ tags: e.tags ?? {}, p: fromWgs([e.lon, e.lat]) });
  }
  return { ways, rels, nodes };
}

// ---------- hlavní běh ----------
const sheets = await sheetsFor();
log('mapové listy:', sheets.join(', '));
const dmr = merge(await Promise.all(sheets.map(async (s) => localize(await loadPoints('DMR5G', s)))));
log('DMR 5G bodů:', dmr.x.length);
const dmp = merge(await Promise.all(sheets.map(async (s) => localize(await loadPoints('DMP1G', s)))));
log('DMP 1G bodů:', dmp.x.length);

const dtm1 = rasterizeTin(dmr, 1); // 1 m výškový model
log('DTM 1 m hotov', dtm1.w, dtm1.h);
const dtmSmooth = blur(dtm1.data, dtm1.w, dtm1.h, 2);
let hmin = Infinity, hmax = -Infinity;
for (const v of dtm1.data) { if (v < hmin) hmin = v; if (v > hmax) hmax = v; }
hmin = Math.floor(hmin) - 1;
log(`výšky ${hmin} – ${hmax.toFixed(1)} m`);
const zAt = (x, y) => { const px = Math.min(dtm1.w - 1, Math.max(0, Math.floor(x))), py = Math.min(dtm1.h - 1, Math.max(0, Math.floor(H - y))); return dtm1.data[py * dtm1.w + px]; };

// porost: v buňkách 4 m nejvyšší bod vegetace nad terénem a podíl vegetačních odrazů
const VR = 4, vw = W / VR, vh = H / VR;
const vegTop = new Float32Array(vw * vh), vegN = new Uint16Array(vw * vh), allN = new Uint16Array(vw * vh), bldN = new Uint16Array(vw * vh);
for (let i = 0; i < dmp.x.length; i++) {
  const x = dmp.x[i], y = dmp.y[i];
  if (x < 0 || y < 0 || x >= W || y >= H) continue;
  const c = Math.floor((H - y) / VR) * vw + Math.floor(x / VR);
  allN[c]++;
  if (dmp.cls[i] === 5) { vegN[c]++; const hh = dmp.z[i] - zAt(x, y); if (hh > vegTop[c]) vegTop[c] = hh; }
  if (dmp.cls[i] === 6) bldN[c]++;
}
const vegFrac = new Float32Array(vw * vh);
for (let i = 0; i < vegFrac.length; i++) vegFrac[i] = allN[i] ? vegN[i] / allN[i] : 0;
const vegFracS = blur(vegFrac, vw, vh, 1);
const vegTopS = blur(vegTop, vw, vh, 1);
log('porost hotov');

const osm = await loadOsm();
log('OSM:', osm.ways.length, 'cest/ploch,', osm.rels.length, 'multipolygonů,', osm.nodes.length, 'bodů');

// ---------- klasifikace OSM ----------
const isSettlement = (t) => /^(residential|commercial|industrial|retail|allotments|cemetery|construction|garages|railway|military|education|religious)$/.test(t.landuse ?? '') || /^(hospital|school|kindergarten|university|college|prison|parking)$/.test(t.amenity ?? '') || /^(garden|sports_centre|stadium|swimming_pool)$/.test(t.leisure ?? '');
const isWater = (t) => t.natural === 'water' || /^(reservoir|basin)$/.test(t.landuse ?? '') || t.leisure === 'swimming_pool';
const isOpen = (t) => /^(meadow|grass|farmland|village_green|recreation_ground)$/.test(t.landuse ?? '') || /^(grassland|heath)$/.test(t.natural ?? '') || /^(park|pitch|playground)$/.test(t.leisure ?? '');
const isScrub = (t) => t.natural === 'scrub';
const isMarsh = (t) => t.natural === 'wetland';
const isForest = (t) => t.landuse === 'forest' || t.natural === 'wood';
const isPaved = (t) => /^(parking|marketplace)$/.test(t.amenity ?? '') || t.area === 'yes' && t.highway === 'pedestrian';
const ROAD = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|pedestrian|motorway_link|primary_link|secondary_link|tertiary_link)$/;
const TRACK = /^(track|cycleway|bridleway)$/;
const PATH = /^(path|footway|steps)$/;

const polys = []; // {tags, rings:[[pts]]} — ringy s evenodd
for (const w of osm.ways) if (w.closed && w.pts.length > 3) polys.push({ tags: w.tags, rings: [w.pts] });
for (const r of osm.rels) {
  // spojit kusy ringů
  const rings = [];
  const pieces = r.rings.map((m) => m.pts.slice());
  while (pieces.length) {
    let ring = pieces.shift();
    let guard = 0;
    while (guard++ < 1000) {
      const end = ring.at(-1), start = ring[0];
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 0.01 && ring.length > 3) break;
      const k = pieces.findIndex((p) => Math.hypot(p[0][0] - end[0], p[0][1] - end[1]) < 0.01 || Math.hypot(p.at(-1)[0] - end[0], p.at(-1)[1] - end[1]) < 0.01);
      if (k < 0) break;
      let p = pieces.splice(k, 1)[0];
      if (Math.hypot(p[0][0] - end[0], p[0][1] - end[1]) >= 0.01) p = p.reverse();
      ring = ring.concat(p.slice(1));
    }
    rings.push(ring);
  }
  polys.push({ tags: r.tags, rings });
}

// ---------- rastrové masky 1 m ----------
function mask(draw) {
  const cv = createCanvas(W, H), g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round';
  draw(g);
  const d = g.getImageData(0, 0, W, H).data, out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] > 127 ? 1 : 0;
  return out;
}
const tx = (p) => [p[0], H - p[1]]; // lokál → pixel (1 m/px)
const pathOf = (g, pts, close) => { g.beginPath(); pts.forEach((p, i) => { const [x, y] = tx(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); if (close) g.closePath(); };
const fillPolys = (g, pred) => { for (const p of polys) if (pred(p.tags)) { g.beginPath(); for (const r of p.rings) r.forEach((pt, i) => { const [x, y] = tx(pt); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.fill('evenodd'); } };
const strokeWays = (g, pred, width) => { g.lineWidth = width; for (const w of osm.ways) if (pred(w.tags)) { pathOf(g, w.pts, false); g.stroke(); } };

const mSettle = mask((g) => fillPolys(g, isSettlement));
const mWater = mask((g) => { fillPolys(g, isWater); strokeWays(g, (t) => t.waterway === 'river', 8); });
const mStream = mask((g) => strokeWays(g, (t) => /^(stream|ditch|drain|canal)$/.test(t.waterway ?? ''), 1.5));
const mBuilding = mask((g) => fillPolys(g, (t) => t.building && t.building !== 'no' || t.man_made === 'tower'));
const mOpen = mask((g) => fillPolys(g, isOpen));
const mForestOsm = mask((g) => fillPolys(g, isForest));
const mScrub = mask((g) => fillPolys(g, isScrub));
const mMarsh = mask((g) => fillPolys(g, isMarsh));
const mPaved = mask((g) => { fillPolys(g, isPaved); });
const mRoad = mask((g) => { strokeWays(g, (t) => ROAD.test(t.highway ?? '') && t.area !== 'yes', 5); });
const mTrack = mask((g) => strokeWays(g, (t) => TRACK.test(t.highway ?? ''), 2.5));
const mPath = mask((g) => strokeWays(g, (t) => PATH.test(t.highway ?? ''), 1.5));
const mFence = mask((g) => strokeWays(g, (t) => /^(fence|wall|city_wall|retaining_wall)$/.test(t.barrier ?? '') && t.barrier !== 'retaining_wall', 1));
log('masky hotovy');

// ---------- povrch (cover) ----------
// kódy musí sedět se src/game/cover.ts
const C = { FOREST: 0, OPEN: 1, ROUGH: 2, GREEN1: 3, GREEN2: 4, GREEN3: 5, WATER: 6, BUILDING: 7, SETTLE: 8, PAVED: 9, PATH: 10, TRACK: 11, ROAD: 12, MARSH: 13, FENCE: 14, STREAM: 15, CLIFF: 16 };

// sklon a skalky z 1 m DTM
const slope = new Float32Array(W * H);
for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
  const i = y * W + x, d = dtm1.data;
  const gx = (d[i + 1] - d[i - 1]) / 2, gy = (d[i + W] - d[i - W]) / 2;
  slope[i] = Math.hypot(gx, gy);
}
const cliff = new Uint8Array(W * H);
for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
  const i = y * W + x;
  if (slope[i] < 1.4) continue; // > ~55°
  // výškový rozdíl v okolí 2 m, aby to nebyl jen šum
  const d = dtm1.data;
  let lo = Infinity, hi = -Infinity;
  for (let j = -2; j <= 2; j++) for (let k = -2; k <= 2; k++) { const v = d[i + j * W + k]; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi - lo >= 2.2) cliff[i] = 1;
}

const cover = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x;
  const vc = Math.min(vh - 1, Math.floor(y / VR)) * vw + Math.min(vw - 1, Math.floor(x / VR));
  const frac = vegFracS[vc], top = vegTopS[vc];
  let c;
  if (frac > 0.45 && top > 5) c = C.FOREST;
  else if (frac > 0.3 && top > 0.5 && top <= 5) c = top < 2.5 ? C.GREEN3 : C.GREEN2;
  else if (frac > 0.25) c = C.ROUGH;
  else c = mForestOsm[i] ? C.ROUGH : C.OPEN;
  // hustníky v lese: řídké vysoké stromy + hodně nízkých odrazů → zelená
  if (c === C.FOREST && top < 9 && frac > 0.7) c = C.GREEN1;
  if (mScrub[i]) c = C.GREEN2;
  if (mOpen[i] && c !== C.FOREST) c = C.OPEN;
  if (mMarsh[i]) c = C.MARSH;
  if (mSettle[i]) c = C.SETTLE;
  if (bldN[vc] > 2 && !mForestOsm[i] && c !== C.FOREST) c = mSettle[i] ? C.SETTLE : c;
  if (mPaved[i]) c = C.PAVED;
  if (cliff[i]) c = C.CLIFF;
  if (mStream[i]) c = C.STREAM;
  if (mWater[i]) c = C.WATER;
  if (mPath[i]) c = C.PATH;
  if (mTrack[i]) c = C.TRACK;
  if (mRoad[i]) c = C.ROAD;
  if (mBuilding[i]) c = C.BUILDING;
  if (mFence[i]) c = C.FENCE;
  cover[i] = c;
}
log('povrch hotov');

// ---------- prvky pro kontroly ----------
const features = [];
const dtm2 = downsample({ data: dtmSmooth, w: W, h: H, res: 1 }, 2);
const covAt = (x, y) => cover[Math.min(H - 1, Math.max(0, Math.floor(H - y))) * W + Math.min(W - 1, Math.max(0, Math.floor(x)))];
const inPlay = (x, y) => { const c = covAt(x, y); return c !== C.SETTLE && c !== C.BUILDING && c !== C.WATER && c !== C.PAVED && c !== C.FENCE; };

// kupky a prohlubně: lokální extrémy v okruhu 12 m s převýšením
{
  const g = dtm2, R = 4; // 4 px = 8 m
  for (let y = R; y < g.h - R; y += 1) for (let x = R; x < g.w - R; x += 1) {
    const v = g.data[y * g.w + x];
    let isMax = true, isMin = true, ringMin = Infinity, ringMax = -Infinity;
    for (let j = -R; j <= R && (isMax || isMin); j++) for (let k = -R; k <= R; k++) {
      if (!j && !k) continue;
      const u = g.data[(y + j) * g.w + x + k];
      if (u >= v) isMax = false;
      if (u <= v) isMin = false;
      if (j * j + k * k >= (R - 1) * (R - 1)) { if (u < ringMin) ringMin = u; if (u > ringMax) ringMax = u; }
    }
    const lx = x * 2 + 1, ly = H - (y * 2 + 1);
    if (!inPlay(lx, ly)) continue;
    if (isMax && v - ringMax >= 0.5) features.push({ t: 'knoll', x: lx, y: ly, h: +(v - ringMax).toFixed(1) });
    if (isMin && ringMin - v >= 0.5) features.push({ t: 'depression', x: lx, y: ly, h: +(ringMin - v).toFixed(1) });
  }
}
// skalky: shluky buněk cliff → těžiště
{
  const seen = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!cliff[i] || seen[i]) continue;
    const stack = [i]; seen[i] = 1; let sx = 0, sy = 0, n = 0;
    while (stack.length) {
      const j = stack.pop(); sx += j % W; sy += Math.floor(j / W); n++;
      for (const d of [1, -1, W, -W]) { const k = j + d; if (k >= 0 && k < W * H && cliff[k] && !seen[k]) { seen[k] = 1; stack.push(k); } }
    }
    if (n >= 6) {
      const x = sx / n, y = H - sy / n;
      // úpatí: posun po spádu dolů o 2 m
      const gx = zAt(x + 1, y) - zAt(x - 1, y), gy = zAt(x, y + 1) - zAt(x, y - 1), gl = Math.hypot(gx, gy) || 1;
      const fx = x - (gx / gl) * 2.5, fy = y - (gy / gl) * 2.5;
      if (inPlay(fx, fy)) features.push({ t: 'cliff', x: +fx.toFixed(1), y: +fy.toFixed(1), h: Math.min(6, Math.round(n / 4)) });
    }
  }
}
// cesty: křižovatky a konce
{
  const key = (p) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
  const deg = new Map(), pos = new Map(), kind = new Map();
  for (const w of osm.ways) {
    const hw = w.tags.highway ?? '';
    if (!(PATH.test(hw) || TRACK.test(hw) || ROAD.test(hw))) continue;
    w.pts.forEach((p, i) => {
      const k = key(p); pos.set(k, p);
      deg.set(k, (deg.get(k) ?? 0) + (i === 0 || i === w.pts.length - 1 ? 1 : 2));
      kind.set(k, Math.max(kind.get(k) ?? 0, PATH.test(hw) ? 1 : TRACK.test(hw) ? 2 : 3));
    });
  }
  for (const [k, d] of deg) {
    const [x, y] = pos.get(k);
    if (x < 30 || y < 30 || x > W - 30 || y > H - 30 || !inPlay(x, y) && covAt(x, y) !== C.PATH && covAt(x, y) !== C.TRACK) continue;
    if (kind.get(k) === 3) continue; // silnice nechceme
    if (d >= 3) features.push({ t: 'junction', x: +x.toFixed(1), y: +y.toFixed(1) });
    else if (d === 1) features.push({ t: 'pathend', x: +x.toFixed(1), y: +y.toFixed(1) });
  }
}
// potoky: ohyby / soutoky z OSM
for (const w of osm.ways) {
  if (!/^(stream|ditch)$/.test(w.tags.waterway ?? '')) continue;
  for (let i = 3; i < w.pts.length - 3; i += 6) { const [x, y] = w.pts[i]; if (x > 20 && y > 20 && x < W - 20 && y < H - 20 && inPlay(x + 3, y)) features.push({ t: 'stream', x: +x.toFixed(1), y: +y.toFixed(1) }); }
}
// body z OSM
for (const n of osm.nodes) {
  const [x, y] = n.p; if (x < 0 || y < 0 || x > W || y > H) continue;
  const t = n.tags.natural === 'stone' ? 'boulder' : n.tags.natural === 'spring' ? 'spring' : n.tags.historic ? 'ruin' : n.tags.natural === 'peak' ? 'knoll' : null;
  if (t) features.push({ t, x: +x.toFixed(1), y: +y.toFixed(1), name: n.tags.name });
}
// rohy a okraje porostů: buňky, kde se v okolí 4 m střídá les a zelená/otevřená plocha
{
  const S = 8;
  for (let y = S; y < H - S; y += 9) for (let x = S; x < W - S; x += 9) {
    const c = cover[y * W + x];
    if (c !== C.FOREST) continue;
    let green = 0, open = 0;
    for (const [dx, dy] of [[S, 0], [-S, 0], [0, S], [0, -S]]) { const k = cover[(y + dy) * W + x + dx]; if (k === C.GREEN2 || k === C.GREEN3) green++; if (k === C.OPEN || k === C.ROUGH) open++; }
    const lx = x, ly = H - y;
    if (green === 1 || green === 2) features.push({ t: 'thicket', x: lx, y: ly });
    else if (open === 1 || open === 2) features.push({ t: 'clearing', x: lx, y: ly });
  }
}

// vzdálenost k nejbližší cestě (pro obtížnost) — BFS na 2 m mřížce
{
  const g = 2, gw = Math.ceil(W / g), gh = Math.ceil(H / g);
  const dist = new Float32Array(gw * gh).fill(Infinity);
  const q = new Int32Array(gw * gh); let qh = 0, qt = 0;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const c = cover[Math.min(H - 1, y * g) * W + Math.min(W - 1, x * g)];
    if (c === C.PATH || c === C.TRACK || c === C.ROAD) { dist[y * gw + x] = 0; q[qt++] = y * gw + x; }
  }
  while (qh < qt) {
    const i = q[qh++], x = i % gw, y = (i / gw) | 0, d = dist[i] + g;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const j = ny * gw + nx; if (dist[j] > d) { dist[j] = d; q[qt++] = j; }
    }
  }
  for (const f of features) f.d = Math.round(dist[Math.min(gh - 1, Math.floor((H - f.y) / g)) * gw + Math.min(gw - 1, Math.floor(f.x / g))]);
}
// prořídit: žádné dva prvky stejného typu blíž než 25 m
{
  const keep = [];
  for (const f of features.sort((a, b) => (b.h ?? 0) - (a.h ?? 0))) if (!keep.some((k) => Math.hypot(k.x - f.x, k.y - f.y) < (k.t === f.t ? 25 : 8))) keep.push(f);
  features.length = 0; features.push(...keep);
}
const featCount = features.reduce((m, f) => ((m[f.t] = (m[f.t] ?? 0) + 1), m), {});
log('prvky:', JSON.stringify(featCount));

// ---------- výstup: terrain.png ----------
{
  const tw = W / 2, th = H / 2;
  const cv = createCanvas(tw, th), g = cv.getContext('2d');
  const img = g.createImageData(tw, th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const v = dtm1.data[(y * 2) * W + x * 2] * 0.25 + dtm1.data[(y * 2) * W + x * 2 + 1] * 0.25 + dtm1.data[(y * 2 + 1) * W + x * 2] * 0.25 + dtm1.data[(y * 2 + 1) * W + x * 2 + 1] * 0.25;
    const cm = Math.max(0, Math.min(65535, Math.round((v - hmin) * 100)));
    const vc = Math.min(vh - 1, Math.floor((y * 2) / VR)) * vw + Math.min(vw - 1, Math.floor((x * 2) / VR));
    const o = (y * tw + x) * 4;
    img.data[o] = cm >> 8; img.data[o + 1] = cm & 255; img.data[o + 2] = Math.min(255, Math.round(Math.max(0, vegTop[vc]) * 4)); img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  writeFileSync(join(OUT, 'terrain.png'), cv.toBuffer('image/png'));
}
// cover.png
{
  const cv = createCanvas(W, H), g = cv.getContext('2d');
  const img = g.createImageData(W, H);
  for (let i = 0; i < W * H; i++) { img.data[i * 4] = cover[i]; img.data[i * 4 + 1] = 0; img.data[i * 4 + 2] = 0; img.data[i * 4 + 3] = 255; }
  g.putImageData(img, 0, 0);
  writeFileSync(join(OUT, 'cover.png'), cv.toBuffer('image/png'));
}
log('terrain.png + cover.png zapsány');

// ---------- ground.webp (barva země do 3D) ----------
{
  const col = {
    [C.FOREST]: [96, 88, 58], [C.OPEN]: [128, 150, 70], [C.ROUGH]: [112, 128, 66], [C.GREEN1]: [78, 96, 52], [C.GREEN2]: [70, 100, 48], [C.GREEN3]: [62, 96, 44],
    [C.WATER]: [52, 84, 98], [C.BUILDING]: [120, 116, 110], [C.SETTLE]: [118, 132, 80], [C.PAVED]: [138, 132, 124], [C.PATH]: [140, 118, 86], [C.TRACK]: [150, 128, 92],
    [C.ROAD]: [96, 96, 98], [C.MARSH]: [88, 106, 72], [C.FENCE]: [96, 88, 58], [C.STREAM]: [60, 80, 80], [C.CLIFF]: [118, 112, 104],
  };
  const cv = createCanvas(W, H), g = cv.getContext('2d');
  const img = g.createImageData(W, H);
  for (let i = 0; i < W * H; i++) { const c = col[cover[i]]; img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255; }
  g.putImageData(img, 0, 0);
  writeFileSync(join(OUT, 'ground.webp'), await cv.encode('webp', 82));
}

// ---------- map.webp (orienťácká mapa 1:10 000) ----------
const PX = 1.25; // px na metr → 1 mm na mapě = 12,5 px
{
  const MW = Math.round(W * PX), MH = Math.round(H * PX);
  const cv = createCanvas(MW, MH), g = cv.getContext('2d');
  const mm = (v) => v * 12.5; // mm na mapě → px
  // 1) plošné barvy z cover (rastr 1 m → škálovat)
  const pal = {
    [C.FOREST]: '#ffffff', [C.OPEN]: '#fbb52b', [C.ROUGH]: '#fedb8f', [C.GREEN1]: '#c5e8b9', [C.GREEN2]: '#8bd17c', [C.GREEN3]: '#3db745',
    [C.WATER]: '#00a8e8', [C.BUILDING]: '#222222', [C.SETTLE]: '#a5ae44', [C.PAVED]: '#e2c79c', [C.PATH]: null, [C.TRACK]: null, [C.ROAD]: null,
    [C.MARSH]: null, [C.FENCE]: null, [C.STREAM]: null, [C.CLIFF]: null,
  };
  const base = createCanvas(W, H), bg = base.getContext('2d');
  const bimg = bg.createImageData(W, H);
  const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  // pro liniové kódy vezmi barvu podkladu z okolí (les)
  const under = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    let c = cover[i];
    if (pal[c] === null) c = mForestOsm[i] || vegFracS[Math.min(vh - 1, Math.floor(Math.floor(i / W) / VR)) * vw + Math.min(vw - 1, Math.floor((i % W) / VR))] > 0.45 ? C.FOREST : mSettle[i] ? C.SETTLE : C.ROUGH;
    under[i] = c;
    const [r, gg, b] = hex(pal[c]);
    bimg.data[i * 4] = r; bimg.data[i * 4 + 1] = gg; bimg.data[i * 4 + 2] = b; bimg.data[i * 4 + 3] = 255;
  }
  bg.putImageData(bimg, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(base, 0, 0, MW, MH);
  const P = (p) => [p[0] * PX, (H - p[1]) * PX];
  const line = (pts, close) => { g.beginPath(); pts.forEach((p, i) => { const [x, y] = P(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); if (close) g.closePath(); };
  g.lineCap = 'round'; g.lineJoin = 'round';

  // 2) bažina — modré čárky
  for (const p of polys) if (isMarsh(p.tags)) { /* vzor: vodorovné čáry */
    g.save(); g.beginPath(); for (const r of p.rings) r.forEach((pt, i) => { const [x, y] = P(pt); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.clip('evenodd');
    g.strokeStyle = '#00a8e8'; g.lineWidth = mm(0.18); for (let y = 0; y < MH; y += mm(0.6)) { g.beginPath(); g.moveTo(0, y); g.lineTo(MW, y); g.stroke(); } g.restore();
  }
  // 3) vrstevnice 5 m (index po 25 m) z vyhlazeného DTM 2 m
  {
    const g2 = downsample({ data: blur(dtm1.data, W, H, 3), w: W, h: H, res: 1 }, 2);
    const lo = Math.ceil(hmin / 5) * 5, thresholds = []; for (let t = lo; t < hmax; t += 5) thresholds.push(t);
    const cs = d3contours().size([g2.w, g2.h]).thresholds(thresholds)(Array.from(g2.data));
    g.strokeStyle = '#d15c00';
    for (const c of cs) {
      g.lineWidth = c.value % 25 === 0 ? mm(0.25) : mm(0.14);
      for (const poly of c.coordinates) for (const ring of poly) {
        if (ring.length < 8) continue;
        // Chaikin vyhlazení
        let r = ring;
        for (let s = 0; s < 2; s++) { const n = []; for (let i = 0; i < r.length - 1; i++) { const a = r[i], b = r[i + 1]; n.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]); } n.push(n[0]); r = n; }
        g.beginPath();
        r.forEach(([x, y], i) => { const px = x * 2 * PX, py = y * 2 * PX; i ? g.lineTo(px, py) : g.moveTo(px, py); });
        g.stroke();
      }
    }
  }
  // 4) potoky, voda
  g.strokeStyle = '#00a8e8';
  for (const w of osm.ways) if (/^(stream|ditch|drain)$/.test(w.tags.waterway ?? '')) { g.lineWidth = w.tags.waterway === 'stream' ? mm(0.25) : mm(0.18); line(w.pts); g.stroke(); }
  g.strokeStyle = '#000'; g.lineWidth = mm(0.18);
  for (const p of polys) if (isWater(p.tags)) for (const r of p.rings) { line(r, true); g.stroke(); }
  // 5) silnice a cesty
  for (const w of osm.ways) {
    const hw = w.tags.highway ?? '';
    if (ROAD.test(hw) && w.tags.area !== 'yes') {
      line(w.pts); g.setLineDash([]); g.strokeStyle = '#000'; g.lineWidth = mm(0.75); g.stroke();
      g.strokeStyle = '#e2c79c'; g.lineWidth = mm(0.5); g.stroke();
    }
  }
  for (const w of osm.ways) {
    const hw = w.tags.highway ?? '';
    if (TRACK.test(hw)) { line(w.pts); g.strokeStyle = '#000'; g.lineWidth = mm(0.35); g.setLineDash([]); g.stroke(); }
    else if (PATH.test(hw)) { line(w.pts); g.strokeStyle = '#000'; g.lineWidth = mm(0.25); g.setLineDash([mm(2), mm(0.25)]); g.stroke(); }
  }
  g.setLineDash([]);
  // 6) budovy, ploty, skalky
  g.fillStyle = '#222';
  for (const p of polys) if (p.tags.building && p.tags.building !== 'no') { g.beginPath(); for (const r of p.rings) r.forEach((pt, i) => { const [x, y] = P(pt); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.fill('evenodd'); }
  g.strokeStyle = '#000'; g.lineWidth = mm(0.18);
  for (const w of osm.ways) if (/^(fence|wall)$/.test(w.tags.barrier ?? '')) { line(w.pts); g.stroke(); }
  g.fillStyle = '#000';
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (cliff[y * W + x]) g.fillRect(x * PX - 0.9, y * PX - 0.9, 2.6, 2.6);
  // 7) bodové prvky
  for (const f of features) {
    const [x, y] = P([f.x, f.y]);
    if (f.t === 'knoll' && (f.h ?? 0) < 2) { g.fillStyle = '#d15c00'; g.beginPath(); g.arc(x, y, mm(0.4), 0, 7); g.fill(); }
    if (f.t === 'depression') { g.strokeStyle = '#d15c00'; g.lineWidth = mm(0.18); g.beginPath(); g.arc(x, y - mm(0.2), mm(0.4), 0.15 * Math.PI, 0.85 * Math.PI); g.stroke(); }
    if (f.t === 'boulder') { g.fillStyle = '#000'; g.beginPath(); g.arc(x, y, mm(0.35), 0, 7); g.fill(); }
    if (f.t === 'spring') { g.strokeStyle = '#00a8e8'; g.lineWidth = mm(0.18); g.beginPath(); g.arc(x, y, mm(0.45), Math.PI, 2 * Math.PI); g.stroke(); }
    if (f.t === 'ruin') { g.strokeStyle = '#000'; g.lineWidth = mm(0.18); g.setLineDash([mm(0.5), mm(0.25)]); g.strokeRect(x - mm(0.6), y - mm(0.6), mm(1.2), mm(1.2)); g.setLineDash([]); }
  }
  // 8) severky (modré, každých 300 m)
  g.strokeStyle = '#00a8e8'; g.lineWidth = mm(0.18);
  for (let x = mm(15); x < MW; x += mm(30)) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, MH); g.stroke(); }
  writeFileSync(join(OUT, 'map.webp'), await cv.encode('webp', 88));
  log('map.webp', MW, MH);
}

// ---------- features.json + meta.json ----------
writeFileSync(join(OUT, 'features.json'), JSON.stringify(features));
const meta = {
  id: ID, name: NAME, version: 1, created: new Date().toISOString().slice(0, 10),
  bbox: [lat1, lon1, lat2, lon2], utmZone: 33, origin: [E0, N0], width: W, height: H,
  hmin, hmax: +hmax.toFixed(1),
  terrain: { file: 'terrain.png', res: 2 }, cover: { file: 'cover.png', res: 1 },
  map: { file: 'map.webp', pxPerM: PX, scale: 10000, contour: 5 }, ground: { file: 'ground.webp', res: 1 },
  features: 'features.json',
  sources: ['© ČÚZK – DMR 5G, DMP 1G (otevřená data)', '© přispěvatelé OpenStreetMap (ODbL)'],
};
writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
// zápis do katalogu
{
  const catPath = join(HERE, '..', 'catalog.json');
  const cat = existsSync(catPath) ? JSON.parse(readFileSync(catPath, 'utf8')) : { maps: [] };
  const size = readdirSync(OUT).reduce((s, f) => s + statSync(join(OUT, f)).size, 0) / 1048576;
  const prev = cat.maps.find((m) => m.id === ID);
  const entry = { id: ID, name: NAME, place: args.place ?? prev?.place ?? '', sizeMB: +size.toFixed(1), version: (prev?.version ?? 0) + 1, description: args.description ?? prev?.description ?? '' };
  meta.version = entry.version;
  writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));
  cat.maps = [...cat.maps.filter((m) => m.id !== ID), entry];
  writeFileSync(catPath, JSON.stringify(cat, null, 2) + '\n');
}
log('hotovo →', OUT);
