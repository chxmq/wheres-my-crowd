// The direct Qloo steps in live mode, with fetch mocked: no network, no harness.
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
globalThis.fetch = async (url, opts) => {
  const u = new URL(String(url));
  seen.push({ url: u, headers: opts?.headers || {} });
  const handler = routes[u.pathname];
  const [status, body] = handler ? handler(u) : [404, { message: "not mocked" }];
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
};
const { resolveAct, crowdCities, rankInCity } = await import("../lib/crowd.js");
const { qlooGet, QlooHttpError, SAMPLE_MODE } = await import("../lib/qloo-api.js");
const { planTour } = await import("../lib/agent.js");

const searchResult = (name, id, extra = {}) => ({ name, entity_id: id, types: ["urn:entity:artist"], popularity: 0.86, disambiguation: name, tags: [{ name: "Indie Pop", tag_id: "urn:tag:genre:music:indie_pop", type: "urn:tag:genre" }, { name: "Some Category", tag_id: "urn:tag:wikipedia_category:x", type: "urn:tag:wikipedia_category:wikidata" }, { name: "Young", tag_id: "urn:tag:audience:qloo:young", type: "urn:tag:audience:qloo" }], ...extra });

test("live mode is on, the hackathon base URL is the default, and the key goes only in X-Api-Key", async () => {
  assert.equal(SAMPLE_MODE, false);
  routes = { "/search": () => [200, { results: [searchResult("Test Act", ID)] }] };
  await qlooGet("/search", { query: "Test Act", types: "urn:entity:artist", take: 5 });
  const last = seen.at(-1);
  assert.equal(last.url.origin, "https://hackathon.api.qloo.com");
  assert.equal(last.headers["X-Api-Key"], process.env.QLOO_API_KEY);
  assert.ok(!last.url.href.includes(process.env.QLOO_API_KEY));
});

test("resolveAct: one exact match resolves, keeping descriptive tags only", async () => {
  routes = { "/search": () => [200, { results: [searchResult("Test Act", ID), searchResult("Test Act Tribute", ID2)] }] };
  const s = await resolveAct({ act: "test act", kind: "musician" });
  assert.equal(s.status, "ok");
  assert.equal(s.extra.act.id, ID);
  assert.deepEqual(s.extra.act.tags.map((t) => t.name), ["Indie Pop", "Young"]);
  const q = seen.at(-1).url.searchParams;
  assert.deepEqual([q.get("query"), q.get("types"), q.get("take")], ["test act", "urn:entity:artist", "5"]);
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
  assert.equal(seen.at(-1).url.searchParams.get("types"), "urn:entity:person");
});

test("resolveAct with a chosen ID looks it up on /entities", async () => {
  routes = { "/entities": () => [200, { results: [searchResult("Twin", ID2)] }] };
  const s = await resolveAct({ act: "Twin", kind: "musician", actId: ID2 });
  assert.equal(s.status, "ok");
  assert.equal(seen.at(-1).url.searchParams.get("entity_ids"), ID2);
});

test("crowdCities sends the documented heatmap query and names the cells", async () => {
  routes = { "/v2/insights": () => [200, heat] };
  const s = await crowdCities({ act: { id: ID, name: "Test Act" }, region: "United States" });
  const q = seen.at(-1).url.searchParams;
  assert.equal(q.get("filter.type"), "urn:heatmap");
  assert.equal(q.get("signal.interests.entities"), ID);
  assert.equal(q.get("filter.location.query"), "United States");
  assert.equal(s.status, "ok");
  assert.equal(s.results[0].name, "New York City");
  assert.equal(s.extra.cells, 7);
});

test("rankInCity comma-joins the shortlist and uses the city as the location signal", async () => {
  routes = { "/v2/insights": () => [200, { success: true, results: { entities: [{ name: "B", entity_id: ID2, subtype: "urn:entity:artist", query: { affinity: 0.98 } }, { name: "A", entity_id: ID, subtype: "urn:entity:artist", query: { affinity: 0.97 } }] } }] };
  const s = await rankInCity({ act: { id: "11111111-1111-4111-8111-111111111111", name: "X" }, kind: "musician", options: [{ id: ID, name: "A" }, { id: ID2, name: "B" }], city: "Bengaluru" });
  const q = seen.at(-1).url.searchParams;
  assert.equal(q.get("filter.results.entities"), `${ID},${ID2}`);
  assert.equal(q.get("signal.location.query"), "Bengaluru");
  assert.deepEqual(s.results.map((r) => r.name), ["B", "A"]);
});

test("HTTP errors map to codes: 401 is not retried, 503 is retried once", async () => {
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
