// The three direct Qloo steps (see lib/qloo-api.js for why these are direct):
// resolve the act, find where its crowd is, and rank a shortlist in one city.
// Each returns a step in the same shape as lib/qloo.js normalize().
import { qlooGet, provenance, SAMPLE_MODE } from "./qloo-api.js";
import { citiesFromHeatmap } from "./geo.js";

export const TYPE_URN = { musician: "urn:entity:artist", comedian: "urn:entity:person" };
export const TOOL_TYPE = { musician: "artist", comedian: "person" };
// Qloo's "person" type covers every public figure; this tag keeps comedians only.
export const COMEDIAN_TAG = "urn:tag:occupation:person:comedian";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => UUID.test(String(s || ""));
// Same rule as the harness: an exact name match after NFKC normalisation and lower-casing.
export const normName = (s) => String(s || "").normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");

const cache = new Map();
const TTL = 6 * 60 * 60 * 1000;
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return { ...structuredClone(hit.value), cached: true };
  const value = await fn();
  if (value.status === "ok") cache.set(key, { at: Date.now(), value: structuredClone(value) });
  return value;
}

const DESCRIPTIVE = /genre|audience|style|theme|characteristic|music:qloo|artist:qloo|occupation/;
const r3 = (x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : null);

function entityFrom(r) {
  const tags = [];
  for (const t of Array.isArray(r?.tags) ? r.tags : []) {
    if (!t?.name || !DESCRIPTIVE.test(String(t.type || "")) || /wikipedia|streaming/.test(String(t.type))) continue;
    if (!tags.some((x) => x.name === t.name)) tags.push({ name: t.name, type: t.type });
  }
  return {
    id: r?.entity_id || r?.id || null,
    name: r?.name || null,
    type: (Array.isArray(r?.types) ? r.types[0] : null) || r?.subtype || null,
    disambiguation: r?.disambiguation || null,
    description: r?.properties?.short_description || r?.properties?.description || null,
    popularity: r3(r?.popularity),
    tags: tags.slice(0, 10),
  };
}

const step = (tool, args, path, params, docs, fields) => ({
  tool, args, status: "ok", summary: "", warnings: [], error: null, results: [], extra: {}, sample: SAMPLE_MODE,
  provenance: provenance(path, params, `https://docs.qloo.com/reference/${docs}`), ...fields,
});

/** Resolve the act's name (or a chosen Qloo ID) to one Qloo entity. */
export async function resolveAct({ act, kind, actId }) {
  const type = TYPE_URN[kind] || TYPE_URN.musician;
  if (actId) {
    const params = { entity_ids: actId };
    const body = await qlooGet("/entities", params);
    const e = (Array.isArray(body?.results) ? body.results : body?.results?.entities || []).map(entityFrom).find((x) => x.id && x.id.toLowerCase() === actId.toLowerCase());
    return step("qloo_resolve", { entity: act || actId, type }, "/entities", params, "get-entities", e
      ? { summary: `Resolved the chosen Qloo ID to ${e.name}.`, results: [{ name: e.name, id: e.id, kind: e.type }], extra: { act: e } }
      : { status: "empty", summary: "Qloo has no entity with that ID." });
  }
  const params = { query: act, types: type, take: 5 };
  const body = await qlooGet("/search", params);
  const cands = (Array.isArray(body?.results) ? body.results : []).map(entityFrom).filter((c) => c.id && c.name);
  const exact = cands.filter((c) => normName(c.name) === normName(act));
  if (exact.length === 1) {
    const e = exact[0];
    return step("qloo_resolve", { entity: act, type }, "/search", params, "get-search", { summary: `Exact match: ${e.name}${e.disambiguation && e.disambiguation !== e.name ? ` (${e.disambiguation})` : ""}.`, results: [{ name: e.name, id: e.id, kind: e.type, ...(e.popularity != null ? { popularity: e.popularity } : {}) }], extra: { act: e } });
  }
  if (cands.length) {
    const pool = exact.length > 1 ? exact : cands;
    return step("qloo_resolve", { entity: act, type }, "/search", params, "get-search", { status: "needs_input", summary: exact.length > 1 ? `Qloo has ${exact.length} entities named "${act}".` : `Qloo has no exact match for "${act}".`, choices: pool.map((c) => ({ id: c.id, name: c.name, type: c.type, description: c.disambiguation && c.disambiguation !== c.name ? c.disambiguation : c.description })) });
  }
  return step("qloo_resolve", { entity: act, type }, "/search", params, "get-search", { status: "empty", summary: `Qloo has no ${kind === "comedian" ? "person" : "artist"} called "${act}".` });
}

/** Where the act's crowd is: the full Qloo heatmap for the region, turned into tour cities. */
export async function crowdCities({ act, region }) {
  const params = { "filter.type": "urn:heatmap", "signal.interests.entities": act.id, "filter.location.query": region };
  return cached(`heat:${act.id}:${region}`, async () => {
    const body = await qlooGet("/v2/insights", params);
    const points = Array.isArray(body?.results?.heatmap) ? body.results.heatmap : [];
    const locality = body?.query?.localities?.filter?.[0]?.name || null;
    const { cities, hotspots, cells } = citiesFromHeatmap(points, region);
    return step("qloo_crowd_cities", { entity: act.name, within: region }, "/v2/insights", params, "heatmaps-use-case", {
      status: cities.length ? "ok" : "empty",
      summary: cities.length ? `${cells} Qloo grid cells for ${locality || region}; ranked the cities of 300k+ people by their strongest cell.` : `Qloo returned ${cells} grid cells for ${region}, none near a city of 300k+ people.`,
      results: [...cities.map((c) => ({ name: c.name, score: c.affinity, where: c.admin1, kind: "tour city" })), ...hotspots.map((h) => ({ name: h.name, score: h.affinity, kind: "outside the tour cities" }))],
      extra: { cities, hotspots, cells, locality },
    });
  });
}

/** Rank a shortlist (Qloo IDs) for this crowd, with a city as the location signal. */
export async function rankInCity({ act, kind, options, city }) {
  const params = { "filter.type": TYPE_URN[kind], "filter.results.entities": options.map((o) => o.id), "signal.interests.entities": act.id, "signal.location.query": city, take: options.length };
  return cached(`rank:${JSON.stringify(params)}`, async () => {
    const body = await qlooGet("/v2/insights", params);
    const rows = Array.isArray(body?.results?.entities) ? body.results.entities : [];
    const results = rows.map((r) => ({ name: r.name, id: r.entity_id, score: r3(r.query?.affinity ?? r.affinity), kind: r.subtype || null })).filter((r) => r.name && r.id);
    return step("qloo_rank", { options: options.map((o) => o.name), signals: [act.name], signal_location: city }, "/v2/insights", params, "insights-api-deep-dive", {
      status: results.length ? "ok" : "empty",
      summary: results.length ? `Ranked ${results.length} acts for ${act.name}'s fans with ${city} as the location signal.` : "Qloo returned no ranking.",
      results,
    });
  });
}
