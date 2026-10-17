// The raw-API Qloo steps in live mode, with the harness API server faked: no network, no subprocess.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
delete process.env.MOCK;
delete process.env.QLOO_BASE_URL;
process.env.QLOO_API_KEY = "test-key-not-a-real-credential";
delete process.env.GEMINI_API_KEY;

const heat = JSON.parse(readFileSync(new URL("./fixtures/heatmap-nyc.json", import.meta.url), "utf8"));
const ID = "871AE4FF-0D03-45CE-A6E1-B255607FA3DD";
const ID2 = "708E858B-D0E9-4606-A64B-47B890D46108";
let routes = {};
const seen = [];
// The harness API server is faked: tool name → [status, body]. No network, no subprocess.
const PATHS = { qloo_search: "/search", qloo_entity: "/entities", qloo_insights: "/v2/insights" };
const fakeHarness = async (tool, args) => {
  seen.push({ tool, args });
  const handler = routes[PATHS[tool]];
  const [status, body] = handler ? handler(args) : [404, { message: "not mocked" }];
  return status >= 200 && status < 300
    ? { content: [{ type: "text", text: JSON.stringify(body) }] }
    : { isError: true, content: [{ type: "text", text: `Qloo API error ${status}: ${body?.message || ""}` }] };
};
const { resolveAct, crowdCities } = await import("../lib/crowd.js");
const { qlooGet, QlooHttpError, SAMPLE_MODE, setRawCaller, baseUrl } = await import("../lib/qloo-api.js");
setRawCaller(fakeHarness);
const { planTour } = await import("../lib/agent.js");

const searchResult = (name, id, extra = {}) => ({ name, entity_id: id, types: ["urn:entity:artist"], popularity: 0.86, disambiguation: name, tags: [{ name: "Indie Pop", tag_id: "urn:tag:genre:music:indie_pop", type: "urn:tag:genre" }, { name: "Some Category", tag_id: "urn:tag:wikipedia_category:x", type: "urn:tag:wikipedia_category:wikidata" }, { name: "Young", tag_id: "urn:tag:audience:qloo:young", type: "urn:tag:audience:qloo" }], ...extra });

test("live mode is on, raw calls go to the harness API server, and the key never appears in a request", async () => {
  assert.equal(SAMPLE_MODE, false);
  assert.equal(baseUrl(), "https://hackathon.api.qloo.com");
  routes = { "/search": () => [200, { results: [searchResult("Test Act", ID)] }] };
  await qlooGet("/search", { query: "Test Act", types: "urn:entity:artist", take: 5 });
  const last = seen.at(-1);
  assert.equal(last.tool, "qloo_search");
  assert.ok(!JSON.stringify(last.args).includes(process.env.QLOO_API_KEY));
});

test("resolveAct: one exact match resolves, keeping descriptive tags only", async () => {
  routes = { "/search": () => [200, { results: [searchResult("Test Act", ID), searchResult("Test Act Tribute", ID2)] }] };
  const s = await resolveAct({ act: "test act", kind: "musician" });
  assert.equal(s.status, "ok");
  assert.equal(s.extra.act.id, ID);
  assert.deepEqual(s.extra.act.tags.map((t) => t.name), ["Indie Pop", "Young"]);
  assert.deepEqual(seen.at(-1), { tool: "qloo_search", args: { query: "test act", type: "urn:entity:artist", take: "5" } });
});

test("resolveAct: several exact matches or no exact match asks the user", async () => {
  routes = { "/search": () => [200, { results: [searchResult("Twin", ID), searchResult("Twin", ID2)] }] };
  const twins = await resolveAct({ act: "Twin", kind: "musician" });
  assert.equal(twins.status, "needs_input");
  assert.equal(twins.choices.length, 2);
  routes = { "/search": () => [200, { results: [searchResult("Something Else", ID)] }] };
  assert.equal((await resolveAct({ act: "Nope", kind: "musician" })).status, "needs_input");
  routes = { "/search": () => [200, { results: [] }] };
  assert.equal((await resolveAct({ act: "Nope", kind: "comedian" })).status, "empty");
  assert.equal(seen.at(-1).args.type, "urn:entity:person");
});

test("resolveAct with a chosen ID looks the entity up through the harness", async () => {
  routes = { "/entities": () => [200, { results: [searchResult("Twin", ID2)] }] };
  const s = await resolveAct({ act: "Twin", kind: "musician", actId: ID2 });
  assert.equal(s.status, "ok");
  assert.deepEqual(seen.at(-1), { tool: "qloo_entity", args: { id: ID2 } });
});

test("crowdCities sends the documented heatmap query and names the cells", async () => {
  routes = { "/v2/insights": () => [200, heat] };
  const s = await crowdCities({ act: { id: ID, name: "Test Act" }, region: "United States" });
  assert.deepEqual(seen.at(-1), { tool: "qloo_insights", args: { type: "urn:heatmap", signal_entities: ID, filter_location: "United States" } });
  assert.equal(s.status, "ok");
  assert.equal(s.results[0].name, "New York City");
  assert.equal(s.extra.cells, 7);
});

test("harness errors map to codes: 401 is not retried, 503 is retried once", async () => {
  let calls = 0;
  routes = { "/search": () => { calls++; return [401, { message: "No API key found in request" }]; } };
  await assert.rejects(qlooGet("/search", { query: "x" }), (e) => e instanceof QlooHttpError && e.code === "QLOO_AUTH" && e.status === 401);
  assert.equal(calls, 1);
  calls = 0;
  routes = { "/search": () => { calls++; return [503, {}]; } };
  await assert.rejects(qlooGet("/search", { query: "x" }), (e) => e.code === "QLOO_UPSTREAM");
  assert.equal(calls, 2);
});

test("planTour stops and asks when Qloo has several acts with that name", async () => {
  routes = { "/search": () => [200, { results: [searchResult("Twin", ID), searchResult("Twin", ID2)] }] };
  const events = [];
  const out = await planTour({ act: "Twin", kind: "musician", region: "India" }, (e) => events.push(e));
  assert.equal(out.choose, true);
  const choose = events.find((e) => e.type === "choose");
  assert.deepEqual(choose.candidates.map((c) => c.id), [ID, ID2]);
  assert.equal(events.filter((e) => e.type === "call").length, 1);
});
