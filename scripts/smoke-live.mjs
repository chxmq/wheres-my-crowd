// Live smoke test for Where's My Crowd.
//
// Calls each Qloo endpoint the app uses once, with the same parameters the app's
// workflow sends through the Qloo harness, and prints the HTTP status and a short
// shape summary of each response, so the first live run shows what to adjust.
// It never prints API keys.
//
//   npm run smoke:live                       # direct endpoint checks (about 9 calls)
//   npm run smoke:live -- --act "Phoebe Bridgers" --region "United States"
//   npm run smoke:live -- --kind comedian --act "Hasan Minhaj" --region "United States"
//   npm run smoke:live -- --app              # also run one full plan through the harness
//   npm run smoke:live -- --save .smoke      # keep raw JSON (git-ignored; never commit Qloo data)
//
// With GEMINI_API_KEY set it also checks the Gemini model and that Gemini accepts
// the app's tool declarations (one small request).
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const { values: opt } = parseArgs({
  options: {
    act: { type: "string", default: "Prateek Kuhad" },
    kind: { type: "string", default: "musician" },
    region: { type: "string", default: "India" },
    app: { type: "boolean", default: false },
    save: { type: "string" },
    probe: { type: "boolean", default: false },
  },
});

const BASE = (process.env.QLOO_BASE_URL || "https://hackathon.api.qloo.com").replace(/\/+$/, "");
const KEY = process.env.QLOO_API_KEY || "";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const SECRETS = [KEY, GEMINI_KEY].filter((s) => s.length >= 8);
const scrub = (s) => SECRETS.reduce((out, k) => out.split(k).join("[redacted]"), String(s));
const say = (...parts) => console.log(scrub(parts.join(" ")));

const type = opt.kind === "comedian" ? "urn:entity:person" : "urn:entity:artist";
const problems = [];
let calls = 0;

function shapeOf(v, depth = 0, max = 3) {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return v.length ? `[${v.length}× ${depth < max ? shapeOf(v[0], depth + 1, max) : "…"}]` : "[]";
  if (typeof v === "object") {
    if (depth >= max) return "{…}";
    const keys = Object.keys(v);
    return `{${keys.slice(0, 16).map((k) => `${k}: ${shapeOf(v[k], depth + 1, max)}`).join(", ")}${keys.length > 16 ? ", …" : ""}}`;
  }
  return typeof v;
}

async function get(label, pathname, params) {
  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const shown = `${pathname}?${[...url.searchParams.keys()].join("&")}`;
  const t0 = Date.now();
  calls++;
  let status = 0, body = null;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", "X-Api-Key": KEY }, signal: AbortSignal.timeout(25000) });
    status = res.status;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { body = { _non_json: text.slice(0, 200) }; }
  } catch (e) {
    body = { _network_error: e.message };
  }
  say(`\n[${calls}] ${label}\n    GET ${shown}\n    HTTP ${status || "network error"} in ${Date.now() - t0} ms`);
  if (status !== 200) {
    const msg = body?.message || body?.error || body?.reason || body?._network_error || JSON.stringify(body).slice(0, 300);
    say(`    error: ${typeof msg === "string" ? msg : JSON.stringify(msg).slice(0, 300)}`);
    problems.push(`${label}: HTTP ${status || "network error"}`);
  }
  if (opt.save) {
    mkdirSync(opt.save, { recursive: true });
    writeFileSync(path.join(opt.save, `${String(calls).padStart(2, "0")}-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`), JSON.stringify({ request: { path: pathname, params }, status, body }, null, 2));
  }
  return { status, body };
}

const list = (body, key) => (Array.isArray(body?.results) ? body.results : Array.isArray(body?.results?.[key]) ? body.results[key] : []);
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const fmt = (n) => (typeof n === "number" ? Math.round(n * 1000) / 1000 : n);

async function main() {
  say(`Where's My Crowd live smoke test`);
  say(`  Qloo base URL : ${BASE}`);
  say(`  QLOO_API_KEY  : ${KEY ? "set" : "MISSING"}`);
  say(`  GEMINI_API_KEY: ${GEMINI_KEY ? "set" : "not set (the app will use its fixed planner)"}`);
  say(`  Test act      : ${opt.act} (${type}), region ${opt.region}`);
  if (!KEY) {
    say(`\nQLOO_API_KEY is missing. Add it to .env (local) or the host's environment, then rerun.`);
    process.exitCode = 2;
    return;
  }

  // 1. Name -> entity (the harness's describe/resolution step uses /search, then /entities)
  const search = await get("Resolve the act (/search)", "/search", { query: opt.act, types: type, take: 5 });
  const cands = list(search.body, "entities");
  say(`    results: ${cands.length}; first result shape: ${shapeOf(cands[0], 0, 1)}`);
  cands.forEach((c, i) => say(`      ${i + 1}. ${c.name} | ${c.entity_id} | ${c.subtype || c.type || ""}${c.disambiguation ? ` | ${c.disambiguation}` : ""}${typeof c.popularity === "number" ? ` | popularity ${fmt(c.popularity)}` : ""}`));
  const exact = cands.filter((c) => norm(c.name) === norm(opt.act));
  const act = exact[0] || cands[0];
  if (!act) {
    say(`\nQloo returned no ${type} entity for "${opt.act}". Try another act with --act.`);
    problems.push("search: no entity");
    return summary();
  }
  if (exact.length !== 1) problems.push(`search: ${exact.length} exact name matches for "${opt.act}" (the harness returns needs_input unless exactly one matches)`);
  const id = act.entity_id;
  say(`    using: ${act.name} (${id})${exact.length === 1 ? " [exact match]" : " [NOT an exact single match]"}`);

  const ent = await get("Hydrate the entity (/entities)", "/entities", { entity_ids: id });
  const e0 = list(ent.body, "entities")[0];
  say(`    shape: ${shapeOf(e0, 0, 1)}`);
  if (e0?.properties) say(`    properties keys: ${Object.keys(e0.properties).join(", ")}`);

  // 2. Audience tags (taste analysis)
  const tags = await get("Audience tags (insights urn:tag)", "/v2/insights", { "filter.type": "urn:tag", "signal.interests.entities": id, take: 6 });
  const tagList = list(tags.body, "tags");
  say(`    tags: ${tagList.length}; first: ${shapeOf(tagList[0], 0, 2)}`);
  say(`    names: ${tagList.map((t) => `${t.name} (${t.subtype || t.type || "?"}${typeof t.query?.affinity === "number" ? `, affinity ${fmt(t.query.affinity)}` : ""})`).join("; ")}`);

  // 3. Where the crowd is (heatmap), as the harness's where_popular sends it
  const heat = await get("Where the crowd is (insights urn:heatmap)", "/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.entities": id, "filter.location.query": opt.region, take: 20 });
  const points = list(heat.body, "heatmap");
  say(`    points: ${points.length}; first: ${shapeOf(points[0], 0, 2)}`);
  say(`    response.query: ${shapeOf(heat.body?.query, 0, 3)}`);
  const lens = [...new Set(points.map((p) => p.location?.geohash?.length).filter(Boolean))];
  say(`    geohash lengths: ${lens.join(", ") || "n/a"}`);
  points.slice(0, 8).forEach((p, i) => say(`      ${i + 1}. ${p.location?.geohash} (${fmt(p.location?.latitude)}, ${fmt(p.location?.longitude)}) affinity ${fmt(p.query?.affinity)} rank ${fmt(p.query?.affinity_rank)} popularity ${fmt(p.query?.popularity)}`));
  let topCity = null;
  try {
    const geo = await import("../lib/geo.js");
    const { cities, hotspots } = geo.citiesFromHeatmap(points, opt.region);
    topCity = cities[0]?.name || null;
    say(`    tour cities (app logic): ${cities.map((c) => `${c.name} ${fmt(c.affinity)}${c.also ? ` [+${c.also.join("/")}]` : ""}`).join("; ") || "none"}`);
    if (hotspots.length) say(`    also strong outside them: ${hotspots.map((h) => `${h.name} ${fmt(h.affinity)}`).join("; ")}`);
  } catch (e) {
    say(`    (city labelling unavailable: ${e.message})`);
  }
  if (!points.length) problems.push(`heatmap: no points for "${opt.region}"`);
  const city = topCity || opt.region;

  // 4. Acts with an overlapping audience
  const recs = await get("Acts this crowd also likes (insights entities)", "/v2/insights", { "filter.type": type, "signal.interests.entities": id, take: 10, "feature.explainability": true });
  const peers = list(recs.body, "entities").filter((r) => r.entity_id !== id);
  say(`    results: ${peers.length}; first: ${shapeOf(peers[0], 0, 1)}`);
  if (peers[0]?.query) say(`    first.query: ${shapeOf(peers[0].query, 0, 3)}`);
  say(`    names: ${peers.map((p) => `${p.name}${typeof p.query?.affinity === "number" ? ` ${fmt(p.query.affinity)}` : ""}`).join("; ")}`);

  // 5. Rank the candidates for this crowd, with the top city as a location signal
  const options = peers.slice(0, 5).map((p) => p.entity_id);
  let opener = null;
  if (options.length) {
    const rank = await get(`Rank openers for this crowd (signal.location.query = ${city})`, "/v2/insights", { "filter.type": type, "filter.results.entities": options, "signal.interests.entities": id, "signal.location.query": city, take: options.length });
    const ranked = list(rank.body, "entities");
    say(`    order: ${ranked.map((r) => `${r.name} ${fmt(r.query?.affinity)}`).join("; ")}`);
    if (rank.body?.query) say(`    response.query: ${shapeOf(rank.body.query, 0, 3)}`);
    opener = ranked[0] || peers[0];
    if (opt.probe) {
      const plain = await get("Probe: same ranking without the location signal", "/v2/insights", { "filter.type": type, "filter.results.entities": options, "signal.interests.entities": id, take: options.length });
      const order = list(plain.body, "entities").map((r) => r.name).join(" > ");
      say(`    order without location: ${order}`);
      say(`    location changed the order: ${order !== ranked.map((r) => r.name).join(" > ")}`);
    }
  }

  // 6. Audience overlap with the chosen opener
  if (opener) {
    const cmp = await get(`Audience overlap with ${opener.name} (analysis/compare)`, "/v2/analysis/compare", { "a.signal.interests.entities": id, "b.signal.interests.entities": opener.entity_id, take: 6 });
    say(`    results shape: ${shapeOf(cmp.body?.results, 0, 3)}`);
    const rows = list(cmp.body, "tags").length ? list(cmp.body, "tags") : list(cmp.body, "entities");
    rows.slice(0, 6).forEach((r, i) => say(`      ${i + 1}. ${r.name ?? r.tag_id ?? r.entity_id ?? JSON.stringify(r).slice(0, 80)} | query ${JSON.stringify(r.query ?? null).slice(0, 160)}`));
    const extra = Object.keys(cmp.body || {}).filter((k) => !["success", "results", "duration"].includes(k));
    if (extra.length) say(`    other top-level keys: ${extra.join(", ")}`);
  }

  // 7. Places this crowd loves in the top city
  const places = await get(`Places this crowd loves in ${city} (insights urn:entity:place)`, "/v2/insights", { "filter.type": "urn:entity:place", "signal.interests.entities": id, "filter.location.query": city, take: 4, "feature.explainability": true });
  const pl = list(places.body, "entities");
  say(`    results: ${pl.length}; first: ${shapeOf(pl[0], 0, 1)}`);
  if (pl[0]?.properties) say(`    first.properties keys: ${Object.keys(pl[0].properties).join(", ")}`);
  pl.forEach((p, i) => say(`      ${i + 1}. ${p.name} | ${p.properties?.address ?? "(no address)"} | affinity ${fmt(p.query?.affinity)}`));

  // 8. Momentum
  const end = new Date();
  const start = new Date(end.getTime() - 182 * 864e5);
  const trend = await get("Momentum (trending)", "/v2/trending", { "filter.type": type, "signal.interests.entities": id, "filter.start_date": start.toISOString().slice(0, 10), "filter.end_date": end.toISOString().slice(0, 10), take: 20 });
  const tp = list(trend.body, "trending");
  say(`    points: ${tp.length}; first: ${shapeOf(tp[0], 0, 2)}`);
  if (tp.length) {
    const days = tp.length > 1 ? Math.round((Date.parse(tp[1].date) - Date.parse(tp[0].date)) / 864e5) : null;
    say(`    dates: ${tp[0].date} … ${tp.at(-1).date} (spacing ${days ?? "?"} days)`);
    say(`    population_percentile: ${tp.map((p) => fmt(p.population_percentile)).join(", ")}`);
  } else problems.push("trending: no points");

  if (opt.probe) {
    const b = await get("Probe: heatmap with output.heatmap.boundary=urn:entity:locality", "/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.entities": id, "filter.location.query": opt.region, "output.heatmap.boundary": "urn:entity:locality", take: 10 });
    say(`    results shape: ${shapeOf(b.body?.results, 0, 3)}`);
  }

  if (GEMINI_KEY) await checkGemini();
  if (opt.app) await runApp();
  summary();
}

async function checkGemini() {
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const base = "https://generativelanguage.googleapis.com/v1beta/models";
  const t0 = Date.now();
  const meta = await fetch(`${base}/${model}`, { headers: { "x-goog-api-key": GEMINI_KEY } }).catch((e) => ({ status: 0, json: async () => ({ error: { message: e.message } }) }));
  const m = await meta.json().catch(() => ({}));
  say(`\n[gemini] GET models/${model}\n    HTTP ${meta.status} in ${Date.now() - t0} ms${meta.status === 200 ? `; resolved to ${m.name}; methods: ${(m.supportedGenerationMethods || []).join(", ")}` : `; ${m.error?.message || ""}`}`);
  if (meta.status !== 200) { problems.push(`gemini model lookup: HTTP ${meta.status}`); return; }
  const { geminiDeclarations } = await import("../lib/agent.js");
  const decls = await geminiDeclarations();
  const t1 = Date.now();
  const res = await fetch(`${base}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: `Plan a tour. Act: ${opt.act}. Region: ${opt.region}. Start by finding where the crowd is.` }] }], tools: [{ functionDeclarations: decls }], toolConfig: { functionCallingConfig: { mode: "ANY" } }, generationConfig: { temperature: 0 } }),
  });
  const j = await res.json().catch(() => ({}));
  const part = j.candidates?.[0]?.content?.parts?.find((p) => p.functionCall);
  say(`[gemini] POST ${model}:generateContent with ${decls.length} tool declarations\n    HTTP ${res.status} in ${Date.now() - t1} ms${res.ok ? `; first function call: ${part ? `${part.functionCall.name} ${JSON.stringify(part.functionCall.args).slice(0, 160)}` : "none"}` : `; ${j.error?.message || ""}`}`);
  if (!res.ok) problems.push(`gemini generateContent: HTTP ${res.status}`);
}

async function runApp() {
  say(`\n[app] Running one full plan through the app's own code path (Qloo harness over MCP)…`);
  const { planTour, AGENT_MODE } = await import("../lib/agent.js");
  const t0 = Date.now();
  const out = await planTour({ act: opt.act, kind: opt.kind === "comedian" ? "comedian" : "musician", region: opt.region }, (e) => {
    if (e.type === "result") {
      const s = e.step;
      say(`    step ${s.n} ${s.tool}: ${s.status}${s.error ? ` (${s.error.code})` : ""}; ${s.results.length} results${s.results.length ? `: ${s.results.slice(0, 4).map((r) => r.name + (r.score != null ? ` ${r.score}` : "")).join("; ")}` : ""}${s.summary && s.status !== "ok" ? ` | ${s.summary}` : ""}`);
      if (s.status !== "ok") problems.push(`app step ${s.n} ${s.tool}: ${s.status}${s.error ? ` ${s.error.code}` : ""}`);
    }
    if (e.type === "choose") say(`    needs a choice: ${e.candidates.map((c) => c.name).join(", ")}`);
  });
  say(`    agent: ${AGENT_MODE}; ${Date.now() - t0} ms`);
  if (out.plan) {
    say(`    headline: ${out.plan.headline}`);
    say(`    cities: ${out.plan.cities.map((c) => c.city).join(", ") || "none"}`);
    say(`    openers: ${out.plan.openers.map((o) => o.name).join(", ") || "none"}`);
    say(`    partners: ${out.plan.partners.map((p) => `${p.name} (${p.city})`).join(", ") || "none"}`);
    say(`    timing: ${out.plan.timing}`);
  }
}

function summary() {
  say(`\nDirect Qloo calls made: ${calls}${opt.app ? " (plus the harness calls for --app)" : ""}`);
  if (problems.length) {
    say(`Needs attention:`);
    for (const p of problems) say(`  - ${p}`);
    process.exitCode = 1;
  } else {
    say(`All checks returned data.`);
  }
}

main()
  .catch((e) => { say(`Smoke test failed: ${e.stack || e.message}`); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50));
