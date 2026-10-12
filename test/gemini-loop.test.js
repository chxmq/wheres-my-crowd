import { test } from "node:test";
import assert from "node:assert/strict";
process.env.MOCK = "1";
process.env.GEMINI_API_KEY = "test-key";

// Scripted model: two Qloo calls, then a plan that includes one invented city.
const script = [
  { functionCall: { name: "qloo_where_popular", args: { entity: "Mitski", entity_type: "artist", within: "United States", limit: 5 } } },
  { functionCall: { name: "qloo_recommend", args: { target_type: "artist", signals: ["Mitski"], limit: 3 } } },
  { functionCall: { name: "submit_tour_plan", args: { headline: "h", cities: [{ city: "__FIRST__", why: "w", evidence: [1] }, { city: "Gotham", why: "w", evidence: [] }], openers: [{ name: "Sample act A", why: "w", evidence: [2] }], partners: [], timing: "t", caveats: [] } } },
];
const seenBodies = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  seenBodies.push(body);
  assert.match(String(url), /generativelanguage\.googleapis\.com/);
  assert.equal(opts.headers["x-goog-api-key"], "test-key");
  const part = structuredClone(script[seenBodies.length - 1]);
  if (part.functionCall.name === "submit_tour_plan") {
    // use the first city the tool actually returned, so grounding keeps it
    const fr = body.contents.flatMap((c) => c.parts || []).find((p) => p.functionResponse?.name === "qloo_where_popular");
    part.functionCall.args.cities[0].city = fr.functionResponse.response.results[0].name;
  }
  return { ok: true, json: async () => ({ candidates: [{ content: { role: "model", parts: [part] } }] }) };
};

const { planTour, AGENT_MODE } = await import("../lib/agent.js");

test("Gemini agent loop: tool calls, responses fed back, grounded plan", async () => {
  assert.equal(AGENT_MODE, "gemini");
  const events = [];
  const out = await planTour({ act: "Mitski", kind: "musician", region: "United States" }, (e) => events.push(e));
  assert.equal(out.steps.length, 2);
  assert.equal(events.filter((e) => e.type === "call").length, 2);
  // the declared tools include the Qloo tools and submit_tour_plan
  const decls = seenBodies[0].tools[0].functionDeclarations.map((d) => d.name);
  assert.ok(decls.includes("qloo_where_popular") && decls.includes("submit_tour_plan"));
  // every functionResponse carries a step number for evidence
  const lastContents = seenBodies.at(-1).contents;
  const responses = lastContents.flatMap((c) => c.parts || []).filter((p) => p.functionResponse);
  assert.deepEqual(responses.map((r) => r.functionResponse.response.step), [1, 2]);
  // the invented city is removed and disclosed
  assert.equal(out.plan.cities.length, 1);
  assert.match(out.plan.caveats.at(-1), /Gotham/);
});
