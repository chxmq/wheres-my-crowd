import { test } from "node:test";
import assert from "node:assert/strict";
process.env.MOCK = "1";
process.env.GEMINI_API_KEY = "test-key";
process.env.GEMINI_CALL_MS = "300"; // so the "hangs" scenario times out fast

// Scripted model: after steps 1-2 (done by the server), one Qloo call, then a plan
// with one invented city. A second scenario simulates the free tier running out.
let scenario = "script";
const seenBodies = [];
globalThis.fetch = async (url, opts) => {
  assert.match(String(url), /generativelanguage\.googleapis\.com/);
  assert.equal(opts.headers["x-goog-api-key"], "test-key");
  const body = JSON.parse(opts.body);
  seenBodies.push(body);
  if (scenario === "hangs") return new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason)));
  if (scenario === "quota") return { ok: false, status: 429, json: async () => ({ error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }) };
  const prompt = body.contents[0].parts[0].text;
  const actId = prompt.match(/Qloo ID ([0-9A-F-]{36})/)[1];
  const firstCity = prompt.match(/\n1\. (.+?) \(fit/)[1];
  const responses = body.contents.flatMap((c) => c.parts || []).filter((p) => p.functionResponse);
  let part;
  if (!responses.length) part = { functionCall: { name: "qloo_recommend", args: { target_type: "artist", signals: [actId], limit: 3 } } };
  else {
    const peer = responses[0].functionResponse.response.results[0].name;
    part = { functionCall: { name: "submit_tour_plan", args: { headline: "h", cities: [{ city: firstCity, why: "w", evidence: [2] }, { city: "Gotham", why: "w", evidence: [] }], openers: [{ name: peer, why: "w", evidence: [3] }], partners: [], timing: "t", caveats: [] } } };
  }
  return { ok: true, json: async () => ({ candidates: [{ content: { role: "model", parts: [part] } }] }) };
};

const { planTour, AGENT_MODE } = await import("../lib/agent.js");

test("Gemini agent loop: steps 1-2 run first, tool calls feed back, the plan is grounded", async () => {
  assert.equal(AGENT_MODE, "gemini");
  const events = [];
  const out = await planTour({ act: "Mitski", kind: "musician", region: "United States" }, (e) => events.push(e));
  assert.equal(out.mode, "gemini");
  assert.deepEqual(out.steps.slice(0, 3).map((s) => s.tool), ["qloo_resolve", "qloo_crowd_cities", "qloo_recommend"]);
  assert.ok(out.steps.slice(3).every((s) => /^Rooms to pitch in /.test(s.label)), "after the agent, only the booking layer's rooms lookups run");
  const decls = seenBodies[0].tools[0].functionDeclarations.map((d) => d.name);
  assert.ok(decls.includes("qloo_recommend") && decls.includes("submit_tour_plan"));
  assert.ok(!decls.includes("qloo_where_popular") && !decls.includes("qloo_entity_tags"));
  const responses = seenBodies.at(-1).contents.flatMap((c) => c.parts || []).filter((p) => p.functionResponse);
  assert.deepEqual(responses.map((r) => r.functionResponse.response.step), [3]);
  assert.equal(out.plan.cities.length, 1);
  assert.match(out.plan.caveats.at(-1), /Gotham/);
  assert.equal(out.plan.openers.length, 1);
});

test("if Gemini fails (for example the free-tier quota), the fixed workflow finishes the plan", async () => {
  scenario = "quota";
  const events = [];
  const out = await planTour({ act: "Mitski", kind: "musician", region: "United States" }, (e) => events.push(e));
  assert.equal(out.mode, "planner");
  assert.ok(events.some((e) => e.type === "note"));
  assert.ok(out.plan.cities.length >= 4 && out.plan.openers.length >= 1);
});

test("if Gemini hangs (overloaded), each call is cut off and the fixed workflow still finishes", async () => {
  scenario = "hangs";
  const events = [];
  const t0 = Date.now();
  const out = await planTour({ act: "Mitski", kind: "musician", region: "United States" }, (e) => events.push(e));
  assert.equal(out.mode, "planner");
  assert.ok(Date.now() - t0 < 5000, "the timeout, not the hang, decides how long a visitor waits");
  assert.ok(events.some((e) => e.type === "note"));
  assert.ok(out.plan.cities.length >= 4);
});
