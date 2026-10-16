import { test } from "node:test";
import assert from "node:assert/strict";
process.env.MOCK = "1";
delete process.env.GEMINI_API_KEY;
const { ground, toGemini, planTour } = await import("../lib/agent.js");

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

test("grounding drops evidence numbers that point at no step, and partners in unknown cities", () => {
  const out = ground({ headline: "h", cities: [{ city: "Austin", why: "", evidence: [1, 9, "2", -1] }], openers: [], partners: [{ city: "Gotham", name: "Cosmic Coffee", why: "", evidence: [3] }], timing: "", caveats: [] }, steps);
  assert.deepEqual(out.cities[0].evidence, [1]);
  assert.equal(out.partners.length, 0);
});

test("Gemini schema drops unsupported keywords and uppercases types", () => {
  const s = toGemini({ type: "object", additionalProperties: false, properties: { a: { type: "array", items: { type: "string", minLength: 1 } }, b: { anyOf: [{ type: "string" }] } }, required: ["a"] });
  assert.deepEqual(s, { type: "OBJECT", properties: { a: { type: "ARRAY", items: { type: "STRING" } }, b: { type: "STRING" } }, required: ["a"] });
});

for (const [input, peerLabel] of [
  [{ act: "Prateek Kuhad", kind: "musician", region: "India" }, /^Sample act/],
  [{ act: "Hasan Minhaj", kind: "comedian", region: "United States" }, /^Sample comedian/],
]) {
  test(`the fixed planner produces a grounded plan end to end (${input.kind}, sample data)`, async () => {
    const events = [];
    const out = await planTour(input, (e) => events.push(e));
    assert.equal(out.mode, "planner");
    assert.equal(out.sample, true);
    assert.deepEqual(out.steps.map((s) => s.tool), ["qloo_resolve", "qloo_crowd_cities", "qloo_recommend", "qloo_rank", "qloo_compare_audiences", "qloo_recommend", "qloo_recommend", "qloo_recommend", "qloo_trends", "qloo_audience_demographics"]);
    assert.ok(out.steps.every((s) => s.status === "ok"));
    assert.equal(events.filter((e) => e.type === "call").length, out.steps.length);
    const p = out.plan;
    assert.equal(p.act.name, input.act);
    assert.ok(p.cities.length >= 4);
    assert.match(p.openers[0].name, peerLabel);
    assert.ok(p.partners.length >= 2);
    assert.ok(p.partners.every((x) => p.cities.some((c) => c.city === x.city)));
    assert.equal(p.trend.length, 20);
    assert.match(p.timing, /^(Steady|Rising|Cooling):/);
    assert.match(p.audience.text, /\(Qloo, aggregate\)\.$/);
    assert.match(p.headline, new RegExp(`^${input.act}'s crowd is strongest in`));
    for (const c of p.cities) assert.ok(c.evidence.every((n) => Number.isInteger(n) && n >= 1 && n <= out.steps.length));
    // the booking log shows names, not Qloo IDs
    const cityCall = events.find((e) => e.type === "call" && e.tool === "qloo_crowd_cities");
    assert.equal(cityCall.args.entity, input.act);
  });
}
