// Offline sample results with the same envelope shape as the Qloo harness.
// Used only when QLOO_API_KEY is missing (local development). Everything here is
// marked sample: true and the UI labels it as sample data, never as Qloo results.

const REGIONS = {
  "India": ["Bengaluru", "Mumbai", "Pune", "Delhi", "Hyderabad", "Kochi", "Shillong", "Kolkata", "Goa", "Chennai", "Guwahati", "Chandigarh"],
  "United States": ["Austin", "Brooklyn", "Portland", "Nashville", "Chicago", "Los Angeles", "Seattle", "Denver", "Philadelphia", "Atlanta", "Minneapolis", "Oakland"],
  "United Kingdom": ["London", "Manchester", "Glasgow", "Bristol", "Leeds", "Brighton", "Birmingham", "Liverpool", "Edinburgh", "Cardiff"],
  "Canada": ["Toronto", "Montreal", "Vancouver", "Ottawa", "Calgary", "Halifax", "Winnipeg", "Edmonton"],
  "Australia": ["Melbourne", "Sydney", "Brisbane", "Perth", "Adelaide", "Hobart", "Canberra"],
};

function seeded(text) {
  let h = 2166136261;
  for (const c of String(text)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1000) / 1000; };
}

const envelope = (operation, results, summary) => ({
  schema_version: "1.0-preview.1", operation, status: results.length ? "ok" : "empty", sample: true,
  summary: `Sample data: ${summary}`, results, result_count: results.length,
  provenance: { source: "sample", endpoint: "none" },
});

export function sampleResult(name, args) {
  const rnd = seeded(JSON.stringify(args));
  switch (name) {
    case "qloo_describe":
      return envelope("describe", [{ name: args.entity, type: args.type || "artist", tags: ["indie", "singer-songwriter", "acoustic"] }], `resolved "${args.entity}"`);
    case "qloo_where_popular": {
      const cities = REGIONS[args.within] || REGIONS["United States"];
      const rows = cities.map((c) => ({ name: c, affinity: 0.55 + rnd() * 0.44 })).sort((a, b) => b.affinity - a.affinity).slice(0, args.limit || 10);
      return envelope("where_popular", rows, `areas within ${args.within} with strong affinity for ${args.entity}`);
    }
    case "qloo_recommend": {
      const n = args.limit || 8;
      const label = args.target_type === "place" ? "Sample venue-adjacent spot" : args.target_type === "brand" ? "Sample brand" : "Sample act";
      const rows = Array.from({ length: n }, (_, i) => ({ name: `${label} ${String.fromCharCode(65 + i)}${args.filter_location ? ` (${args.filter_location})` : ""}`, affinity: 0.9 - i * 0.05 - rnd() * 0.03, type: args.target_type }));
      return envelope("recommend", rows, `${args.target_type} recommendations for fans of ${(args.signals || []).join(", ")}`);
    }
    case "qloo_rank": {
      const rows = (args.options || []).map((o) => ({ name: o, score: rnd() })).sort((a, b) => b.score - a.score);
      return envelope("rank", rows, `ranked ${rows.length} options`);
    }
    case "qloo_compare_audiences": {
      const rows = Array.from({ length: 6 }, (_, i) => ({ name: `Shared interest ${i + 1}`, overlap: 0.8 - i * 0.1 }));
      return envelope("compare_audiences", rows, `audience overlap between ${args.group_a?.join(", ")} and ${args.group_b?.join(", ")}`);
    }
    case "qloo_trends": {
      const rows = (args.entities || []).map((e) => ({ name: e, value: 0.4 + rnd() * 0.6 }));
      return envelope("trends", rows, `popularity trend for ${rows.length} entities`);
    }
    case "qloo_entity_tags":
      return envelope("entity_tags", ["late-night", "heartbreak", "acoustic", "college crowd", "chill"].map((t) => ({ name: t })), "characterising tags");
    case "qloo_audience_demographics":
      return envelope("audience_demographics", [{ name: "18-24", value: 0.42 }, { name: "25-34", value: 0.38 }], "age distribution");
    case "qloo_find_tags":
      return envelope("find_tags", [{ name: args.query, urn: `urn:tag:sample:${args.query}` }], `tags matching "${args.query}"`);
    default:
      return { status: "error", sample: true, summary: `Unknown tool ${name}`, results: [], error: { code: "UNKNOWN_TOOL", retryable: false, recovery: "" } };
  }
}

export const REGION_NAMES = Object.keys(REGIONS);
