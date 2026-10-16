// Offline sample data for local development without a Qloo key. Every response
// has the same shape as the live Qloo API or the Qloo harness envelope (checked
// against the hackathon API on 2026-10-16), so the same parsers run in both modes.
// Everything here is marked sample: true and the UI labels it as sample data.
// City names come from GeoNames; every name and number attributed to Qloo is made up.
import { geohash, tourCities } from "./geo.js";

function seeded(text) {
  let h = 2166136261;
  for (const c of String(text)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
}

// A stable UUID-shaped ID (version 4 layout) so ID handling matches live mode.
export function sampleUuid(text) {
  const rnd = seeded(`id:${text}`);
  const hex = Array.from({ length: 32 }, () => Math.floor(rnd() * 16).toString(16));
  hex[12] = "4";
  hex[16] = "89ab"[Math.floor(rnd() * 4)];
  const s = hex.join("").toUpperCase();
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const names = new Map(); // sample ID -> name, so /entities and rank can echo names
function entity(name, subtype, extra = {}) {
  const id = sampleUuid(`${subtype}:${name}`);
  names.set(id, name);
  return { name, entity_id: id, type: "urn:entity", subtype, ...extra };
}

const SAMPLE_TAGS = {
  "urn:entity:artist": [["Sample genre tag", "urn:tag:genre:music"], ["Sample style tag", "urn:tag:music:qloo"], ["Sample audience tag", "urn:tag:audience:qloo"]],
  "urn:entity:person": [["Comedian", "urn:tag:occupation:person"], ["Sample genre tag", "urn:tag:genre:media"], ["Sample audience tag", "urn:tag:audience:qloo"]],
};

// ---- direct REST endpoints (lib/qloo-api.js) ----
export function sampleApi(path, params) {
  if (path === "/search") {
    const type = params.types || "urn:entity:artist";
    const e = entity(String(params.query || "Sample act"), type);
    const tags = (SAMPLE_TAGS[type] || SAMPLE_TAGS["urn:entity:artist"]).map(([name, t]) => ({ name, tag_id: `${t}:sample_${name.toLowerCase().replace(/\W+/g, "_")}`, type: t, value: "" }));
    return { results: [{ name: e.name, entity_id: e.entity_id, types: [type], properties: { short_description: "Sample entity" }, popularity: 0.8, disambiguation: e.name, tags }] };
  }
  if (path === "/entities") {
    const id = String(params.entity_ids || "");
    return { results: [{ name: names.get(id) || "Sample act", entity_id: id, types: ["urn:entity:artist"], properties: {}, popularity: 0.8, tags: [] }] };
  }
  if (path === "/v2/insights" && params["filter.type"] === "urn:heatmap") return sampleHeatmap(params["signal.interests.entities"], params["filter.location.query"]);
  if (path === "/v2/insights" && params["filter.results.entities"]) {
    const ids = String(params["filter.results.entities"]).split(",");
    const rnd = seeded(`${ids}:${params["signal.location.query"]}`);
    const entities = ids.map((id) => ({ name: names.get(id) || "Sample act", entity_id: id, type: "urn:entity", subtype: params["filter.type"], popularity: 0.7, query: { affinity: 0.8 + rnd() * 0.19 } })).sort((a, b) => b.query.affinity - a.query.affinity);
    return { success: true, results: { entities }, query: { localities: { signal: { name: params["signal.location.query"], subtype: "urn:entity:locality" } } } };
  }
  return { success: true, results: { entities: [] } };
}

function sampleHeatmap(entityId, region) {
  const rnd = seeded(`${entityId}:${region}`);
  const cities = tourCities(region, 30);
  if (!cities.length) return { success: true, results: { heatmap: [] } };
  const raw = cities.map((c) => ({ lat: c.lat + (rnd() - 0.5) * 0.08, lon: c.lon + (rnd() - 0.5) * 0.08, s: 0.3 + rnd() * 0.7 }));
  const lats = cities.map((c) => c.lat), lons = cities.map((c) => c.lon);
  const [la0, la1, lo0, lo1] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  for (let i = 0; i < 240; i++) raw.push({ lat: la0 + rnd() * (la1 - la0), lon: lo0 + rnd() * (lo1 - lo0), s: rnd() * 0.8 });
  // Live affinities are rank-normalised across the returned cells; do the same.
  [...raw].sort((a, b) => a.s - b.s).forEach((p, i, all) => { p.affinity = i / (all.length - 1); });
  const heatmap = raw.sort((a, b) => b.affinity - a.affinity).map((p) => ({
    location: { latitude: Number(p.lat.toFixed(4)), longitude: Number(p.lon.toFixed(4)), geohash: geohash(p.lat, p.lon, 4) },
    query: { affinity: p.affinity, affinity_rank: 0.25 + p.affinity * 0.75, popularity: Number(rnd().toFixed(3)) },
  }));
  return { success: true, results: { heatmap }, query: { localities: { filter: [{ name: region, subtype: "urn:entity:locality" }] } } };
}

// ---- Qloo harness envelopes (lib/qloo.js) ----
const envelope = (operation, payload, summary, endpoint = "/v2/insights") => ({
  schema_version: "1.0-preview.1", operation, status: "ok", sample: true, summary: `Sample data: ${summary}`,
  ...payload,
  provenance: { source: "sample", endpoint, documentation: "https://docs.qloo.com/reference/insights-api-deep-dive" },
});

const compact = (e, affinity, properties) => ({ entity_id: e.entity_id, name: e.name, type: "urn:entity", subtype: e.subtype, popularity: 0.6, affinity, ...(properties ? { properties } : {}) });

export function sampleResult(name, args) {
  const rnd = seeded(JSON.stringify(args));
  switch (name) {
    case "qloo_recommend": {
      const n = args.limit || 10;
      const type = `urn:entity:${args.target_type}`;
      const comedians = (args.include_tags || []).some((t) => /comedian/.test(t));
      const label = args.target_type === "place" ? "Sample spot" : comedians ? "Sample comedian" : args.target_type === "brand" ? "Sample brand" : "Sample act";
      const city = args.filter_location ? ` (${args.filter_location})` : "";
      const results = Array.from({ length: n }, (_, i) => compact(entity(`${label} ${String.fromCharCode(65 + i)}${city}`, type), 0.95 - i * 0.02 - rnd() * 0.01, args.target_type === "place" ? { address: `Sample address${city}` } : undefined));
      return envelope("recommend", { results, result_count: results.length }, `${args.target_type} recommendations`);
    }
    case "qloo_rank": {
      const results = (args.options || []).map((o) => compact({ entity_id: o, name: names.get(o) || o, subtype: `urn:entity:${args.option_type}` }, rnd())).sort((a, b) => b.affinity - a.affinity);
      return envelope("rank", { results, result_count: results.length }, `ranked ${results.length} options`);
    }
    case "qloo_compare_audiences": {
      const tag = (i, score) => ({ tag_id: `urn:tag:genre:music:sample_${i}`, name: `Sample shared tag ${i}`, type: "urn:tag", subtype: "urn:tag:genre:music", popularity: 0.9, query: score == null ? { count: "1" } : { score } });
      return envelope("compare_audiences", { results: { tags: [1, 2, 3, 4].map((i) => tag(i, 0.95 - i * 0.05)), a: [tag(5), tag(6)], b: [tag(7), tag(8)], matchEntities: [] } }, "audience comparison", "/v2/analysis/compare");
    }
    case "qloo_trends": {
      const end = new Date(`${args.end_date}T00:00:00Z`);
      const base = 4000 + Math.floor(rnd() * 3000), drift = Math.floor((rnd() - 0.5) * 60);
      const points = Array.from({ length: Math.min(args.limit || 10, 20) }, (_, i) => {
        const d = new Date(end.getTime() - i * 7 * 864e5);
        return { date: d.toISOString().slice(0, 10), population_percentile: 0.5, population_rank: String(base + drift * i), population_rank_velocity: drift, velocity_fold_change: 0, population_percent_delta: 0 };
      });
      const series = (args.entities || []).map((e) => ({ entity: { input: e, entityId: e, name: names.get(e) || e, match: "identifier" }, points }));
      return envelope("trends", { series, result_count: series.length }, "weekly trend values", "/v2/trending");
    }
    case "qloo_audience_demographics": {
      const v = () => Number((rnd() - 0.5).toFixed(2));
      const g = v();
      return envelope("audience_demographics", { results: [{ entity_id: args.entity, query: { age: { "24_and_younger": v(), "25_to_29": v(), "30_to_34": v(), "35_to_44": v(), "45_to_54": v(), "55_and_older": v() }, gender: { male: g, female: -g } } }], result_count: 1 }, "aggregate demographics");
    }
    case "qloo_find_tags":
      return envelope("find_tags", { results: [{ id: `urn:tag:sample:${String(args.query).toLowerCase().replace(/\W+/g, "_")}`, name: args.query, type: "urn:tag:sample" }], result_count: 1 }, `tags matching "${args.query}"`, "/v2/tags");
    case "qloo_entity_tags":
      return envelope("entity_tags", { results: [{ id: "urn:tag:sample:one", name: "Sample tag", type: "urn:tag:sample" }], result_count: 1 }, "characterising tags");
    case "qloo_describe": {
      const e = entity(String(args.entity), `urn:entity:${args.type || "artist"}`);
      return envelope("describe", { results: [compact(e)], result_count: 1 }, `resolved "${args.entity}"`, "/entities");
    }
    default:
      return { status: "error", sample: true, summary: `Unknown tool ${name}`, results: [], error: { code: "UNKNOWN_TOOL", retryable: false, recovery: "" } };
  }
}
