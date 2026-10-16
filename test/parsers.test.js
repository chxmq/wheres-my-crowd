// Documented Qloo responses are fed through the real Qloo harness workflow code
// (with a fake HTTP client), and the envelopes it produces go through the app's
// parsers. This checks the parsers against what the harness really emits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.MOCK = "1";
process.env.QLOO_HOME = path.join(os.tmpdir(), "wmc-test-qloo-home");
const { createDirectQlooWorkflowExecutor } = await import("@qloo/qloo-harness");
const { normalize, pick } = await import("../lib/qloo.js");

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const ACT = "871AE4FF-0D03-45CE-A6E1-B255607FA3DD";
const OTHER = "708E858B-D0E9-4606-A64B-47B890D46108";

function fakeClient(overrides = {}) {
  return {
    async entities(ids) { return { results: ids.map((id) => ({ entity_id: id, name: id === ACT ? "Test Act" : "Other Act", types: ["urn:entity:artist"] })) }; },
    async searchEntities() { return { results: [] }; },
    async insights(q) {
      if (q["filter.type"] === "urn:heatmap") return fixture("heatmap-nyc");
      if (q["filter.type"] === "urn:tag") return fixture("taste-analysis-tags");
      if (q["filter.type"] === "urn:demographics") return fixture("demographics");
      return fixture("insights-entities-movie");
    },
    async trending() { return fixture("trending"); },
    // /v2/analysis/compare has no documented example. This mirrors the structure the
    // hackathon API returned on 2026-10-16 ({tags, a, b, matchEntities}); values are placeholders.
    async compare() {
      const t = (id, query) => ({ tag_id: `urn:tag:genre:music:${id}`, name: `Tag ${id}`, type: "urn:tag", subtype: "urn:tag:genre:music", entity_id: "00000000-0000-4000-8000-000000000000", popularity: 0.9, query });
      return { duration: 1, results: { tags: [t("one", { score: 0.99 }), t("two", { score: 0.5 })], a: [t("a1", { count: "1" })], b: [t("b1", { count: "1" })], matchEntities: [] } };
    },
    async tags() { return { results: { tags: [] } }; },
    ...overrides,
  };
}

const run = async (operation, input, client = fakeClient()) => (await createDirectQlooWorkflowExecutor(client).execute(operation, input)).result;

test("recommend: compact entities keep name, ID, affinity source and subtype", async () => {
  const env = await run("recommend", { target_type: "movie", signals: [ACT], limit: 5 });
  const n = normalize("qloo_recommend", {}, env);
  assert.equal(n.status, "ok");
  assert.deepEqual(n.results[0], { name: "Everything Everywhere All at Once", id: "F0D354AA-BA7E-49D2-8ABA-9A8250F5C852", kind: "urn:entity:movie", popularity: 0.998 });
  assert.equal(n.provenance.endpoint, "/v2/insights");
});

test("where_popular: heatmap cells are named by geohash, never [object Object]", async () => {
  const env = await run("where_popular", { entity: ACT, entity_type: "artist", within: "New York City", limit: 3 });
  const n = normalize("qloo_where_popular", {}, env);
  assert.deepEqual(n.results.map((r) => r.name), ["dr5wct", "dr5ryb", "dr72nj"]);
  assert.equal(n.results[0].score, 1);
  assert.ok(n.results.every((r) => !/object Object/.test(r.name)));
});

test("entity_tags: raw tag_id/subtype tags parse to names and IDs", async () => {
  const env = await run("entity_tags", { entities: [ACT], entity_type: "artist", limit: 4 });
  const n = normalize("qloo_entity_tags", {}, env);
  assert.deepEqual(n.results.map((r) => r.name), ["Brady Bunch", "Mining Accident", "Complex", "Hostile Environment"]);
  assert.equal(n.results[0].id, "urn:tag:keyword:media:brady_bunch");
});

test("audience_demographics: age and gender affinities from the first result", async () => {
  const env = await run("audience_demographics", { entity: ACT, entity_type: "artist" });
  const n = normalize("qloo_audience_demographics", {}, env);
  assert.deepEqual(n.extra.demographics.age.find((a) => a.band === "25–29"), { band: "25–29", value: 0.43 });
  assert.deepEqual(n.extra.demographics.gender, [{ band: "male", value: 0.08 }, { band: "female", value: -0.08 }]);
  assert.deepEqual(n.results, []);
});

test("trends: the envelope carries series, not results; numeric and string ranks both parse", async () => {
  const env = await run("trends", { entities: [ACT], entity_type: "artist", start_date: "2025-01-01", end_date: "2025-03-30", limit: 20 });
  assert.equal(env.results, undefined);
  const n = normalize("qloo_trends", {}, env);
  assert.deepEqual(n.extra.series[0].points[0], { date: "2025-01-03", rank: 150, percentile: 85.2, velocity: 5 });
  const live = await run("trends", { entities: [ACT], entity_type: "artist", start_date: "2025-01-01", end_date: "2025-03-30", limit: 20 },
    fakeClient({ async trending() { return { success: true, results: { trending: [{ date: "2025-01-10", population_percentile: 0.1, population_rank: "108163", population_rank_velocity: 0 }] } }; } }));
  assert.equal(normalize("qloo_trends", {}, live).extra.series[0].points[0].rank, 108163);
});

test("compare_audiences: results is an object; shared tags are scored, a/b tags are kept", async () => {
  const env = await run("compare_audiences", { group_a: [ACT], group_b: [OTHER], limit: 5 });
  assert.equal(Array.isArray(env.results), false);
  const n = normalize("qloo_compare_audiences", {}, env);
  assert.deepEqual(n.results.map((r) => [r.name, r.score]), [["Tag one", 0.99], ["Tag two", 0.5]]);
  assert.deepEqual(n.extra, { a: ["Tag a1"], b: ["Tag b1"] });
});

test("needs_input: two exact matches surface as choices", async () => {
  const twins = { async searchEntities() { return { results: [{ entity_id: ACT, name: "Same Name", types: ["urn:entity:artist"], disambiguation: "band" }, { entity_id: OTHER, name: "Same Name", types: ["urn:entity:artist"], disambiguation: "rapper" }] }; } };
  const env = await run("describe", { entity: "Same Name", type: "artist" }, fakeClient(twins));
  const n = normalize("qloo_describe", {}, env);
  assert.equal(n.status, "needs_input");
  assert.deepEqual(n.choices.map((c) => c.id), [ACT, OTHER]);
});

test("errors keep the code and drop results", () => {
  const n = normalize("qloo_rank", {}, { status: "error", summary: "bad", error: { code: "QLOO_AUTH", layer: "qloo", retryable: false, recovery: "r" } });
  assert.equal(n.status, "error");
  assert.equal(n.error.code, "QLOO_AUTH");
  assert.deepEqual(n.results, []);
});

test("pick handles strings, compact tags and objects without names", () => {
  assert.deepEqual(pick("Denver"), { name: "Denver" });
  assert.deepEqual(pick({ id: "urn:tag:x", name: "X", type: "urn:tag:genre:music", affinity: 0.91234 }), { name: "X", id: "urn:tag:x", score: 0.912, kind: "urn:tag:genre:music" });
  assert.equal(pick({ query: { affinity: 1 } }), null);
});
