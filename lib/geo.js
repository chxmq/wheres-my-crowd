// Turns a Qloo heatmap (a grid of geohash cells, each with a query-relative
// affinity) into tour stops. Qloo returns coordinates, not place names, so each
// cell is labelled with a nearby city from GeoNames (data/cities.json, CC BY 4.0).
// The ranking itself comes only from Qloo's affinity values.
import { readFileSync } from "node:fs";

export const REGION_CODES = { "India": "IN", "United States": "US", "United Kingdom": "GB", "Canada": "CA", "Australia": "AU" };
export const REGION_NAMES = Object.keys(REGION_CODES);

const TOUR_MIN_POP = 300_000; // a tour stop is a city of 300k+ people
const CORE_KM = 30;           // cells within this distance of a city centre describe that city
const MARKET_KM = 80;         // one stop per market: a lower-ranked city this close is folded into the stop
const TOWN_KM = 75;           // strong cells away from the stops are named after a town this close
const BUCKET = 0.5;           // degrees per spatial-index bucket

let DATA = null;
function data() {
  DATA ??= JSON.parse(readFileSync(new URL("../data/cities.json", import.meta.url), "utf8"));
  return DATA;
}

export function km(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// How far a city's metro reaches, growing with population: 10 km at 100k, about 40 km at 1M, at most 60 km.
export function metroRadiusKm(population) {
  return Math.max(10, Math.min(60, 10 + 9 * Math.log2(Math.max(population, 1) / 100_000)));
}

const indexes = new Map();
function regionIndex(code) {
  if (indexes.has(code)) return indexes.get(code);
  const rows = data().countries[code] || [];
  const all = rows.map(([name, admin1, lat, lon, population]) => ({ name, admin1, lat, lon, population }));
  const buckets = new Map();
  for (const c of all) {
    const k = `${Math.floor(c.lat / BUCKET)},${Math.floor(c.lon / BUCKET)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(c);
  }
  // Tour cities, largest first; a city inside a larger city's metro is part of that metro.
  const big = all.filter((c) => c.population >= TOUR_MIN_POP);
  const counts = new Map();
  for (const c of big) counts.set(c.name, (counts.get(c.name) || 0) + 1);
  const tour = [];
  for (const c of big) {
    const host = tour.find((t) => km(t.lat, t.lon, c.lat, c.lon) <= metroRadiusKm(t.population));
    if (host) continue;
    c.label = counts.get(c.name) > 1 && c.admin1 ? `${c.name}, ${c.admin1}` : c.name;
    tour.push(c);
  }
  const idx = { all, buckets, tour };
  indexes.set(code, idx);
  return idx;
}

function near(idx, lat, lon, maxKm) {
  const out = [];
  const dLat = Math.ceil(maxKm / 111 / BUCKET);
  const dLon = Math.ceil(maxKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180))) / BUCKET);
  const bi = Math.floor(lat / BUCKET), bj = Math.floor(lon / BUCKET);
  for (let i = bi - dLat; i <= bi + dLat; i++) {
    for (let j = bj - dLon; j <= bj + dLon; j++) {
      for (const c of idx.buckets.get(`${i},${j}`) || []) {
        const d = km(lat, lon, c.lat, c.lon);
        if (d <= maxKm) out.push({ c, d });
      }
    }
  }
  return out;
}

function cell(p) {
  const lat = p?.location?.latitude, lon = p?.location?.longitude, affinity = p?.query?.affinity;
  if (typeof lat !== "number" || typeof lon !== "number" || typeof affinity !== "number") return null;
  return { lat, lon, affinity, popularity: typeof p.query.popularity === "number" ? p.query.popularity : null, geohash: p.location.geohash || null };
}

const round = (x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : x);

/**
 * Rank the tour cities of a region by the strongest Qloo heatmap cell within
 * CORE_KM of each city centre (one stop per market), and list strong cells that
 * lie outside every stop's market.
 * @param {Array} points heatmap points: { location: {latitude, longitude, geohash}, query: {affinity, popularity} }
 * @param {string} region one of REGION_NAMES
 */
export function citiesFromHeatmap(points, region, { limit = 8, hotspots = 4 } = {}) {
  const code = REGION_CODES[region];
  const cells = (Array.isArray(points) ? points : []).map(cell).filter(Boolean);
  if (!code || !cells.length) return { cities: [], hotspots: [], cells: cells.length };
  const idx = regionIndex(code);
  const sorted = cells.map((c) => c.affinity).sort((a, b) => a - b);
  const beats = (a) => {
    let lo = 0, hi = sorted.length; // count of cells with affinity strictly below a
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < a) lo = m + 1; else hi = m; }
    return lo / sorted.length;
  };

  // Spatial lookup of cells.
  const grid = new Map();
  for (const c of cells) {
    const k = `${Math.floor(c.lat / BUCKET)},${Math.floor(c.lon / BUCKET)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(c);
  }
  const cellsNear = (lat, lon, maxKm) => {
    const out = [];
    const bi = Math.floor(lat / BUCKET), bj = Math.floor(lon / BUCKET);
    const dLon = Math.ceil(maxKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180))) / BUCKET);
    for (let i = bi - 1; i <= bi + 1; i++) for (let j = bj - dLon; j <= bj + dLon; j++) for (const c of grid.get(`${i},${j}`) || []) if (km(lat, lon, c.lat, c.lon) <= maxKm) out.push(c);
    return out;
  };

  const ranked = [];
  for (const city of idx.tour) {
    const mine = cellsNear(city.lat, city.lon, CORE_KM);
    if (!mine.length) continue;
    const best = mine.reduce((a, b) => (b.affinity > a.affinity || (b.affinity === a.affinity && (b.popularity ?? 0) > (a.popularity ?? 0)) ? b : a));
    ranked.push({ name: city.label, admin1: city.admin1, lat: city.lat, lon: city.lon, population: city.population, affinity: round(best.affinity), popularity: round(best.popularity), beats: round(beats(best.affinity)), geohash: best.geohash, cells: mine.length });
  }
  ranked.sort((a, b) => b.affinity - a.affinity || (b.popularity ?? 0) - (a.popularity ?? 0) || b.population - a.population);

  // One stop per market: a lower-ranked city near a chosen stop is folded into it.
  const cities = [];
  for (const c of ranked) {
    const stop = cities.find((s) => km(s.lat, s.lon, c.lat, c.lon) <= MARKET_KM);
    if (stop) { (stop.also ||= []).push(c.name); continue; }
    if (cities.length < limit) cities.push(c);
  }

  // Strong cells outside every stop's market: smaller scenes and destinations.
  const floor = cities.length ? cities.at(-1).affinity : 0;
  const spots = [];
  for (const c of [...cells].sort((a, b) => b.affinity - a.affinity)) {
    if (c.affinity < floor || spots.length >= hotspots) break;
    if (cities.some((s) => km(s.lat, s.lon, c.lat, c.lon) <= MARKET_KM)) continue;
    const towns = near(idx, c.lat, c.lon, TOWN_KM);
    if (!towns.length) continue; // remote cell with no town of 15k+ nearby
    const close = towns.filter((t) => t.d <= CORE_KM);
    const town = close.length ? close.sort((a, b) => b.c.population - a.c.population)[0] : towns.sort((a, b) => a.d - b.d)[0];
    if (spots.some((s) => km(s.lat, s.lon, town.c.lat, town.c.lon) <= 50)) continue; // same area as a listed spot
    spots.push({ name: town.c.admin1 ? `${town.c.name}, ${town.c.admin1}` : town.c.name, lat: town.c.lat, lon: town.c.lon, km: Math.round(town.d), affinity: round(c.affinity), popularity: round(c.popularity), beats: round(beats(c.affinity)), geohash: c.geohash });
  }
  return { cities, hotspots: spots, cells: cells.length };
}

// Geohash encoding (used to build sample heatmaps in offline mode).
const B32 = "0123456789bcdefghjkmnpqrstuvwxyz";
export function geohash(lat, lon, precision = 4) {
  let latR = [-90, 90], lonR = [-180, 180], bit = 0, ch = 0, even = true, out = "";
  while (out.length < precision) {
    const r = even ? lonR : latR, v = even ? lon : lat, mid = (r[0] + r[1]) / 2;
    if (v >= mid) { ch = (ch << 1) | 1; r[0] = mid; } else { ch <<= 1; r[1] = mid; }
    even = !even;
    if (++bit === 5) { out += B32[ch]; bit = 0; ch = 0; }
  }
  return out;
}

export function tourCities(region, n = 40) {
  const code = REGION_CODES[region];
  return code ? regionIndex(code).tour.slice(0, n) : [];
}
