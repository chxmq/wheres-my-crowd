// Backtest: do the cities Where's My Crowd ranks highest for an artist match where that artist really toured?
// Ground truth: US cities from Wikipedia tour-date tables (tours.json, built by fetch_tours.py, no API key).
//   node --env-file=../.env eval.mjs fetch     resolve each artist in Qloo and save its raw US heatmap (heat/)
//   DEV=tours-dev.json TOURS=tours-holdout.json node eval.mjs score [K]
//                                                  offline: rank cities several ways on held-out tours (weights tuned on DEV)
// Qloo is called exactly as the app calls it (through the harness), once per artist; scoring never calls Qloo.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tourCities, citiesFromHeatmap, km } from "../lib/geo.js";

const mode = process.argv[2] || "score";
const tours = JSON.parse(readFileSync(process.env.TOURS || "tours.json", "utf8")).slice(0, Number(process.env.MAX || 1e9));
mkdirSync("heat", { recursive: true });
const slug = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

if (mode === "fetch") {
  const { resolveAct } = await import("../lib/crowd.js");
  const { qlooGet } = await import("../lib/qloo-api.js");
  for (const t of tours) {
    const f = `heat/${slug(t.artist)}.json`;
    if (existsSync(f)) continue;
    // Only an exact, unambiguous name match: a wrong entity would make the test meaningless.
    const who = await resolveAct({ act: t.artist, kind: "musician" }).catch((e) => ({ status: "error", summary: e.message }));
    if (who.status !== "ok") { writeFileSync(f, JSON.stringify({ artist: t.artist, skipped: `${who.status}: ${who.summary}` })); console.log("skip", t.artist, who.status); continue; }
    const act = who.extra.act;
    const body = await qlooGet("/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.entities": act.id, "filter.location.query": "United States" }).catch((e) => ({ error: e.message }));
    const points = (body?.results?.heatmap || []).map((p) => [p.location?.latitude, p.location?.longitude, p.query?.affinity, p.query?.popularity]).filter((p) => typeof p[2] === "number");
    writeFileSync(f, JSON.stringify({ artist: t.artist, qloo: { id: act.id, name: act.name, popularity: act.popularity ?? null }, points }));
    console.log(`${t.artist.slice(0, 30).padEnd(30)} -> ${act.name} (${points.length} cells)`);
  }
  process.exit(0);   // the harness subprocess would otherwise keep node alive
}

// ---------- scoring (offline) ----------
const K = Number(process.argv[3] || 8);
const METRO_KM = 60;                                     // a city counts as played if a show was within 60 km
const US = JSON.parse(readFileSync("../data/cities.json", "utf8")).countries.US.map(([name, admin1, lat, lon, pop]) => ({ name, admin1, lat, lon, pop }));
const byName = new Map();
for (const c of US) { const k = c.name.toLowerCase(); if (!byName.has(k) || byName.get(k).pop < c.pop) byName.set(k, c); }
// Stadium and amphitheatre towns too small for the city list, mapped to the metro they serve.
const ALIAS = { "washington, d.c.": "washington", "washington d.c.": "washington", "st. louis": "saint louis", "st. paul": "saint paul", "st. petersburg": "saint petersburg",
  "east rutherford": "jersey city", "foxborough": "boston", "foxboro": "boston", "mansfield": "boston", "orchard park": "buffalo", "darien center": "buffalo", "holmdel": "new york city", "wantagh": "new york city",
  "uniondale": "new york city", "bristow": "washington", "noblesville": "indianapolis", "tinley park": "chicago", "clarkston": "detroit", "burgettstown": "pittsburgh", "maryland heights": "saint louis",
  "wheatland": "sacramento", "morrison": "denver", "englewood": "denver", "camden": "philadelphia", "cuyahoga falls": "akron", "auburn": "seattle", "ridgefield": "portland", "the woodlands": "houston" };
function geocode(s) {
  const raw = s.toLowerCase().replace(/\s+/g, " ").replace(/ \(.*\)$/, "").trim();
  const [name, state] = raw.split(/,\s*/);
  if (state) { const hit = US.find((c) => c.name.toLowerCase() === (ALIAS[name] && !byName.has(name) ? ALIAS[name] : name) && c.admin1.toLowerCase() === state); if (hit) return hit; }
  for (const k of [ALIAS[raw], raw, name, ALIAS[name]].filter(Boolean)) if (byName.has(k)) return byName.get(k);
  return null;
}
const played = (c, actual) => actual.some((a) => km(c.lat, c.lon, a.lat, a.lon) <= METRO_KM);
const CANDIDATES = tourCities("United States", 1000);   // the app's tour cities (300k+, metro-folded), largest first
const fold = (list) => {                                 // one stop per market, as the app does
  const out = [];
  for (const c of list) { if (!out.some((s) => km(s.lat, s.lon, c.lat, c.lon) <= 80)) out.push(c); if (out.length === K) break; }
  return out;
};

// City features from one heatmap: strongest cell within 30 km (the app's rule), and the crowd size proxy.
function features(points) {
  const cells = points.map(([lat, lon, affinity, popularity]) => ({ lat, lon, affinity, popularity }));
  return CANDIDATES.map((c, i) => {
    const mine = cells.filter((x) => Math.abs(x.lat - c.lat) < 0.4 && km(c.lat, c.lon, x.lat, x.lon) <= 30);
    if (!mine.length) return null;
    const best = mine.reduce((a, b) => (b.affinity > a.affinity ? b : a));
    return { ...c, popRank: i, affinity: best.affinity, cellPop: Math.max(...mine.map((x) => x.popularity ?? 0)) };
  }).filter(Boolean);
}
const rankBy = (feats, score) => fold([...feats].sort((a, b) => score(b) - score(a)));
const pct = (arr, key) => { const s = arr.map((x) => x[key]).sort((a, b) => a - b); return (v) => s.findIndex((x) => x >= v) / Math.max(1, s.length - 1); };
// Blend: percentile of Qloo affinity among this act's cities, and percentile of city size. w = weight on Qloo.
const blend = (w) => (feats) => {
  const a = pct(feats, "affinity"), n = feats.length, pos = new Map(feats.map((c, j) => [c, j]));   // feats are in size order
  return rankBy(feats, (c) => w * a(c.affinity) + (1 - w) * (1 - pos.get(c) / Math.max(1, n - 1)));
};
const RANKERS = {
  "Population only": () => fold(CANDIDATES),
  "Old app ranking (strongest affinity cell)": (feats) => rankBy(feats, (c) => c.affinity + c.cellPop * 1e-6),
  "Where's My Crowd (shipped: demand)": (feats, points) => citiesFromHeatmap(points.map(([latitude, longitude, affinity, popularity]) => ({ location: { latitude, longitude }, query: { affinity, popularity } })), "United States", { limit: K }).cities,
  "Qloo cell popularity": (feats) => rankBy(feats, (c) => c.cellPop),
};

function load(list) {
const rows = [];
for (const t of list) {
  const f = `heat/${slug(t.artist)}.json`;
  if (!existsSync(f)) continue;
  const h = JSON.parse(readFileSync(f, "utf8"));
  if (h.skipped || !h.points?.length) { rows.push({ artist: t.artist, skipped: h.skipped || "no heatmap cells" }); continue; }
  const actual = t.us_cities.map(geocode).filter(Boolean);
  if (actual.length < 8) { rows.push({ artist: t.artist, skipped: `only ${actual.length} US cities geocoded` }); continue; }
  rows.push({ artist: t.artist, tour: t.tour, qloo: h.qloo, actual, feats: features(h.points), points: h.points, notGeocoded: t.us_cities.filter((c) => !geocode(c)) });
}
return rows;
}
const rows = load(tours);
const done = rows.filter((r) => !r.skipped);
const hits = (list, r) => list.filter((c) => played(c, r.actual)).length;
const evalSet = (set, rank) => set.reduce((s, r) => s + hits(rank(r.feats, r.points), r), 0) / (set.length * K || 1);

// Tune the blend weight on DEV tours if given (else on half of these), report every method on the rest.
const DEV = process.env.DEV ? load(JSON.parse(readFileSync(process.env.DEV, "utf8"))).filter((r) => !r.skipped) : null;
const train = DEV || done.filter((_, i) => i % 2 === 0), test = DEV ? done : done.filter((_, i) => i % 2 === 1);
const W = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
const trainScores = W.map((w) => ({ w, p: evalSet(train, blend(w)) }));
const bestW = process.env.FIXW ? Number(process.env.FIXW) : trainScores.reduce((a, b) => (b.p > a.p ? b : a)).w;
RANKERS[`Blend: Qloo affinity ${bestW} + size ${Math.round((1 - bestW) * 10) / 10} (weight tuned on ${DEV ? "dev tours" : "train half"})`] = blend(bestW);

const r3 = (x) => Math.round(x * 1000) / 1000;
const methods = Object.fromEntries(Object.entries(RANKERS).map(([k, rank]) => [k, { test: r3(evalSet(test, rank)), all: r3(evalSet(done, rank)) }]));
// Per tour, does the blend beat population on the test half?
const pop = RANKERS["Population only"], best = blend(bestW);
const vs = test.map((r) => hits(best(r.feats), r) - hits(pop(), r));
const summary = {
  K, metroKm: METRO_KM, tours: done.length, skipped: rows.length - done.length, train: train.length, test: test.length,
  precisionAtK: methods, trainCurve: trainScores.map((s) => ({ w: s.w, p: r3(s.p) })),
  blendVsPopulationOnTest: { better: vs.filter((x) => x > 0).length, tie: vs.filter((x) => x === 0).length, worse: vs.filter((x) => x < 0).length },
};
writeFileSync(`results-k${K}.json`, JSON.stringify({ summary, rows: rows.map((r) => r.skipped ? r : {
  artist: r.artist, tour: r.tour, qloo: r.qloo, played: r.actual.length, notGeocoded: r.notGeocoded,
  app: RANKERS["Where's My Crowd (shipped: demand)"](r.feats, r.points).map((c) => `${c.name}${played(c, r.actual) ? " ✓" : ""}`),
  blend: best(r.feats).map((c) => `${c.name}${played(c, r.actual) ? " ✓" : ""}`),
  population: pop().map((c) => `${c.name}${played(c, r.actual) ? " ✓" : ""}`),
}) }, null, 1));
console.log(JSON.stringify(summary, null, 1));
