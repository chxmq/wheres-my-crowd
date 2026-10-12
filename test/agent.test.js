import { test } from "node:test";
import assert from "node:assert/strict";
process.env.MOCK = "1";
const { ground, toGemini, planTour } = await import("../lib/agent.js");
const { normalize } = await import("../lib/qloo.js");

const steps = [
  { n: 1, results: [{ name: "Austin" }, { name: "Portland" }] },
  { n: 2, results: [{ name: "Japanese Breakfast" }, { name: "Mitski" }] },
  { n: 3, results: [{ name: "Cosmic Coffee" }] },
];

test("grounding keeps names that Qloo returned", () => {
  const out = ground({ headline: "h", cities: [{ city: "austin", why: "", evidence: [1] }], openers: [{ name: "Mitski", why: "", evidence: [2] }], partners: [{ city: "Austin", name: "Cosmic Coffee", why: "", evidence: [3] }], timing: "", caveats: [] }, steps);
  assert.equal(out.cities.length, 1);
  assert.equal(out.openers.length, 1);
  assert.equal(out.partners.length, 1);
  assert.equal(out.caveats.length, 0);
});

test("grounding removes invented names and says so", () => {
  const out = ground({ headline: "h", cities: [{ city: "Atlantis", why: "", evidence: [] }], openers: [{ name: "Made Up Band", why: "", evidence: [] }], partners: [], timing: "", caveats: [] }, steps);
  assert.equal(out.cities.length, 0);
  assert.equal(out.openers.length, 0);
  assert.match(out.caveats.at(-1), /Removed 2 suggestion\(s\).*Atlantis.*Made Up Band/);
});

test("Gemini schema drops unsupported keywords and uppercases types", () => {
  const s = toGemini({ type: "object", additionalProperties: false, properties: { a: { type: "array", items: { type: "string", minLength: 1 } }, b: { anyOf: [{ type: "string" }] } }, required: ["a"] });
  assert.deepEqual(s, { type: "OBJECT", properties: { a: { type: "ARRAY", items: { type: "STRING" } }, b: { type: "STRING" } }, required: ["a"] });
});

test("normalize reads the common result shapes and keeps provenance", () => {
  const n = normalize("qloo_where_popular", { entity: "x" }, { status: "ok", summary: "s", provenance: { source: "qloo", endpoint: "/v2/insights", documentation: "d" }, results: [{ name: "Austin", affinity: 0.91234 }, { entity: { name: "Portland" }, score: 0.5 }, "Denver"] });
  assert.deepEqual(n.results.map((r) => r.name), ["Austin", "Portland", "Denver"]);
  assert.equal(n.results[0].score, 0.912);
  assert.deepEqual(n.provenance, { source: "qloo", endpoint: "/v2/insights" });
});

test("normalize reports errors without results", () => {
  const n = normalize("qloo_rank", {}, { status: "error", summary: "bad", error: { code: "QLOO_AUTH", retryable: false, recovery: "r" } });
  assert.equal(n.status, "error");
  assert.equal(n.error.code, "QLOO_AUTH");
  assert.deepEqual(n.results, []);
});

test("the fixed planner produces a grounded plan end to end (sample data)", async () => {
  const events = [];
  const out = await planTour({ act: "Phoebe Bridgers", kind: "musician", region: "United States" }, (e) => events.push(e));
  assert.equal(out.mode, "planner");
  assert.ok(out.plan.cities.length >= 4);
  assert.ok(out.plan.openers.length >= 1);
  assert.ok(out.steps.every((s) => s.status === "ok"));
  assert.equal(events.filter((e) => e.type === "call").length, out.steps.length);
  assert.match(out.plan.headline, /Phoebe Bridgers' crowd/);
});
