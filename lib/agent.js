// The tour-planning agent. Steps 1 and 2 always run first: resolve the act to one
// Qloo entity (asking the user when Qloo has several), then rank the region's
// cities from Qloo's heatmap. With GEMINI_API_KEY set, Gemini chooses the remaining
// Qloo tools; without it, or if Gemini fails, a fixed booking workflow runs.
// Either way, every name on the poster must come from a Qloo result (grounding check).
import { callQloo, qlooTools } from "./qloo.js";
import { resolveAct, crowdCities, rankInCity, TOOL_TYPE, COMEDIAN_TAG, normName, isUuid } from "./crowd.js";
import { SAMPLE_MODE } from "./qloo-api.js";

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
export const AGENT_MODE = GEMINI_KEY ? "gemini" : "planner";
const MAX_TOOL_CALLS = 12;
const TREND_WEEKS = 20; // the harness returns at most 20 weekly points, newest first
const AGENT_TOOLS = ["qloo_recommend", "qloo_rank", "qloo_compare_audiences", "qloo_trends", "qloo_audience_demographics", "qloo_find_tags"];

export class PlanError extends Error {} // messages safe to show the user

const PLAN_SCHEMA = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING", description: "One sentence: where this act's crowd is and the shape of the tour." },
    cities: { type: "ARRAY", description: "4-8 stops, best first, chosen from the step 2 cities, names exactly as listed there.", items: { type: "OBJECT", properties: {
      city: { type: "STRING" }, why: { type: "STRING", description: "One sentence citing the Qloo evidence." }, evidence: { type: "ARRAY", items: { type: "INTEGER" }, description: "Step numbers of the tool calls that support this." } }, required: ["city", "why", "evidence"] } },
    openers: { type: "ARRAY", description: "1-3 acts to tour with, names exactly as returned by Qloo.", items: { type: "OBJECT", properties: {
      name: { type: "STRING" }, why: { type: "STRING" }, evidence: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["name", "why", "evidence"] } },
    partners: { type: "ARRAY", description: "Places in tour cities that this crowd loves, for promo or after-show events. City names exactly as in step 2.", items: { type: "OBJECT", properties: {
      city: { type: "STRING" }, name: { type: "STRING" }, why: { type: "STRING" }, evidence: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["city", "name", "why", "evidence"] } },
    timing: { type: "STRING", description: "When to go, from the trends evidence, or say the evidence is inconclusive." },
    caveats: { type: "ARRAY", items: { type: "STRING" }, description: "What the data does not establish." },
  },
  required: ["headline", "cities", "openers", "partners", "timing", "caveats"],
};

function systemPrompt(input, act) {
  const t = TOOL_TYPE[input.kind];
  return `You are Where's My Crowd, a tour-planning agent for independent musicians and comedians.
Steps 1 and 2 are done: the act is resolved to a Qloo ID, and Qloo's heatmap has ranked the region's cities (step 2). Continue like a booking agent, using ONLY evidence from Qloo tools:
3. Find acts with an overlapping audience: qloo_recommend with target_type "${t}", signals ["${act.id}"]${input.kind === "comedian" ? `, include_tags ["${COMEDIAN_TAG}"]` : ""}.
4. Rank the best 4-6 candidates for this crowd in the top city: qloo_rank with their Qloo IDs as options, option_type "${t}", signals ["${act.id}"], signal_location = the top city.
5. Confirm the best one with qloo_compare_audiences (group_a ["${act.id}"], group_b [its Qloo ID]).
6. For the top 2-3 cities, find places this crowd loves: qloo_recommend with target_type "place", signals ["${act.id}"], filter_location = the city name exactly as in step 2. If the artist's notes ask for a kind of place, find its tag with qloo_find_tags first and pass it as include_tags.
7. Check momentum with qloo_trends (entity_type "${t}", the last ${TREND_WEEKS} weeks, limit ${TREND_WEEKS}); optionally qloo_audience_demographics.
Rules: pass Qloo IDs, not names, wherever you can. Never invent names, cities or numbers; use names exactly as tools return them, and choose cities only from step 2. If a tool returns needs_input or empty, adjust once, then move on. Qloo results are aggregate affinities, not facts about individuals; say so in caveats. Use at most ${MAX_TOOL_CALLS} tool calls, then call submit_tour_plan once, citing step numbers as evidence.`;
}

// Gemini accepts an OpenAPI subset: uppercase types, no anyOf/minLength/additionalProperties.
export function toGemini(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  if (schema.type) out.type = String(schema.type).toUpperCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.items) out.items = toGemini(schema.items);
  if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toGemini(v)]));
  if (schema.required?.length) out.required = schema.required;
  if (typeof schema.minimum === "number") out.minimum = schema.minimum;
  if (typeof schema.maximum === "number") out.maximum = schema.maximum;
  if (!out.type && schema.properties) out.type = "OBJECT";
  if (!out.type) out.type = "STRING";
  return out;
}

export async function geminiDeclarations() {
  const mcpTools = (await qlooTools()).filter((t) => AGENT_TOOLS.includes(t.name));
  const decls = mcpTools.map((t) => ({ name: t.name, description: t.description?.slice(0, 900), parameters: toGemini(t.inputSchema) }));
  decls.push({ name: "submit_tour_plan", description: "Submit the final tour plan. Call this exactly once, last.", parameters: PLAN_SCHEMA });
  return decls;
}

async function gemini(contents, tools, system) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: tools }],
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
      generationConfig: { temperature: 0.3 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${data.error?.status || "request failed"}`);
  return data.candidates?.[0]?.content || { role: "model", parts: [] };
}

// What the model sees from each tool call: enough to reason, small enough to stay cheap.
function compact(step) {
  const out = { step: step.n, status: step.status, summary: step.summary, error: step.error?.code || null, results: step.results.slice(0, 12).map(({ name, id, score, where }) => ({ name, id, score, where })) };
  if (step.choices) out.candidates = step.choices.slice(0, 5);
  if (step.extra?.a) Object.assign(out, { tags_of_a: step.extra.a, tags_of_b: step.extra.b });
  const pts = step.extra?.series?.[0]?.points;
  if (pts?.length) out.trend = { newest: pts[0], oldest: pts.at(-1), weeks: pts.length };
  if (step.extra?.demographics) out.demographics = step.extra.demographics;
  return out;
}

export async function planTour(input, emit) {
  const steps = [];
  const names = new Map(); // Qloo ID -> name, to show names instead of IDs in the booking log
  const shown = (v) => (Array.isArray(v) ? v.map(shown) : typeof v === "string" && isUuid(v) ? names.get(v.toUpperCase()) || v : v);
  const run = async (label, tool, args, exec) => {
    const n = steps.length + 1;
    emit({ type: "call", n, tool, label, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, shown(v)])) });
    let step;
    try {
      step = await exec();
    } catch (e) {
      console.error(`${tool} failed:`, e.code || "", e.status || "", e.message);
      step = { tool, args, status: "error", summary: e.code === "QLOO_AUTH" ? "Qloo rejected the request (check the API key and base URL)." : e.message, error: { code: e.code || "ERROR", retryable: Boolean(e.retryable) }, results: [], extra: {}, provenance: null, sample: SAMPLE_MODE };
    }
    step = { ...step, n, label };
    for (const r of step.results) if (r.id) names.set(String(r.id).toUpperCase(), r.name);
    steps.push(step);
    emit({ type: "result", step });
    return step;
  };
  const harness = (label, tool, args) => run(label, tool, args, () => callQloo(tool, args));

  // 1. Who is this act?
  const who = await run(`Who is “${input.act}”?`, "qloo_resolve", { entity: input.act }, () => resolveAct(input));
  if (who.status === "needs_input") {
    emit({ type: "choose", act: input.act, candidates: who.choices || [] });
    return { choose: true, steps, mode: AGENT_MODE, sample: SAMPLE_MODE };
  }
  if (who.status !== "ok") throw new PlanError(who.status === "error" ? "Qloo couldn't look up the act just now. Try again in a minute." : `${who.summary} Try the name of an act you sound like.`);
  const act = who.extra.act;
  names.set(act.id.toUpperCase(), act.name);

  // 2. Where is the crowd?
  const where = await run(`Where ${possessive(act.name)} crowd is in ${input.region}`, "qloo_crowd_cities", { entity: act.id, within: input.region }, () => crowdCities({ act, region: input.region }));

  const ctx = { input, act, where, steps, run, harness };
  let plan, mode = AGENT_MODE;
  if (AGENT_MODE === "gemini") {
    try {
      plan = await geminiAgent(ctx, emit);
    } catch (e) {
      console.error("gemini agent stopped:", e.message);
      emit({ type: "note", text: "The planning model is unavailable right now, so the fixed booking workflow finished this plan." });
      plan = await fixedPlanner(ctx);
      mode = "planner";
    }
  } else {
    plan = await fixedPlanner(ctx);
  }
  return { plan: { ...ground(plan, steps), ...extras(ctx) }, steps, mode, sample: SAMPLE_MODE };
}

async function geminiAgent(ctx, emit) {
  const { input, act, where, harness } = ctx;
  const decls = await geminiDeclarations();
  const today = new Date().toISOString().slice(0, 10);
  const cities = (where.extra?.cities || []).map((c, i) => `${i + 1}. ${c.name} (affinity ${c.affinity})`).join("\n");
  const hot = (where.extra?.hotspots || []).map((h) => h.name).join("; ");
  const contents = [{ role: "user", parts: [{ text: `Plan a tour.
Act: ${act.name} (Qloo ID ${act.id}, Qloo type ${TOOL_TYPE[input.kind]})${act.tags.length ? `; Qloo tags: ${act.tags.slice(0, 6).map((t) => t.name).join(", ")}` : ""}
Region: ${input.region}
Today: ${today}${input.notes ? `\nArtist's notes: ${input.notes}` : ""}
Step 2 (Qloo heatmap) ranked these cities by audience affinity, best first:
${cities || "(none)"}${hot ? `\nAlso strong outside those cities: ${hot}` : ""}
Continue from step 3.` }] }];
  let calls = 0;
  for (let turn = 0; turn <= MAX_TOOL_CALLS + 2; turn++) {
    const content = await gemini(contents, decls, systemPrompt(input, act));
    contents.push(content);
    const fcs = (content.parts || []).filter((p) => p.functionCall);
    const text = (content.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join(" ").trim();
    if (text) emit({ type: "thought", text: text.slice(0, 400) });
    if (!fcs.length) throw new Error("Gemini stopped without a plan.");
    const responses = [];
    for (const { functionCall: fc } of fcs) {
      if (fc.name === "submit_tour_plan") return fc.args || {};
      if (!AGENT_TOOLS.includes(fc.name) || calls >= MAX_TOOL_CALLS) {
        responses.push({ functionResponse: { name: fc.name, response: { error: "Tool budget used up: call submit_tour_plan now." } } });
        continue;
      }
      calls++;
      const step = await harness(agentLabel(fc.name, fc.args || {}, act), fc.name, fc.args || {});
      responses.push({ functionResponse: { name: fc.name, response: compact(step) } });
    }
    contents.push({ role: "user", parts: responses });
  }
  throw new Error("Gemini ran out of turns.");
}

function agentLabel(tool, a, act) {
  if (tool === "qloo_recommend") return a.target_type === "place" ? `Places ${possessive(act.name)} fans love${a.filter_location ? ` in ${a.filter_location}` : ""}` : `${a.target_type === "person" ? "People" : "Acts"} that ${possessive(act.name)} fans also like`;
  if (tool === "qloo_rank") return `Rank ${(a.options || []).length} options for ${possessive(act.name)} fans${a.signal_location ? ` in ${a.signal_location}` : ""}`;
  if (tool === "qloo_compare_audiences") return "Compare two audiences";
  if (tool === "qloo_trends") return `${possessive(act.name)} weekly trend`;
  if (tool === "qloo_audience_demographics") return `Who is in ${possessive(act.name)} audience`;
  if (tool === "qloo_find_tags") return `Find the Qloo tag for “${a.query}”`;
  return tool;
}

// Same workflow without an LLM: deterministic, used when no Gemini key is configured.
async function fixedPlanner(ctx) {
  const { input, act, where, run, harness } = ctx;
  const t = TOOL_TYPE[input.kind];
  const comedian = input.kind === "comedian";
  const cities = where.extra?.cities || [];

  const peers = await harness(`${comedian ? "Comedians" : "Acts"} that ${possessive(act.name)} fans also like`, "qloo_recommend", { target_type: t, signals: [act.id], limit: 10, ...(comedian ? { include_tags: [COMEDIAN_TAG] } : {}) });
  const shortlist = peers.results.filter((r) => r.id && r.id !== act.id && normName(r.name) !== normName(act.name)).slice(0, 6);
  const top = cities[0]?.name;
  const ranked = shortlist.length > 1 && top
    ? await run(`Which of them ${possessive(act.name)} fans like most in ${top}`, "qloo_rank", { options: shortlist.map((o) => o.id), signals: [act.id], signal_location: top }, () => rankInCity({ act, kind: input.kind, options: shortlist, city: top }))
    : null;
  const order = ranked?.status === "ok" && ranked.results.length ? ranked.results : shortlist;
  const opener = order[0];
  const overlap = opener ? await harness(`What ${possessive(act.name)} and ${possessive(opener.name)} audiences share`, "qloo_compare_audiences", { group_a: [act.id], group_b: [opener.id], limit: 10 }) : null;
  const partnerSteps = [];
  for (const c of cities.slice(0, 3)) partnerSteps.push(await harness(`Places ${possessive(act.name)} fans love in ${c.name}`, "qloo_recommend", { target_type: "place", signals: [act.id], filter_location: c.name, limit: 4 }));
  const end = new Date(), start = new Date(end.getTime() - (TREND_WEEKS * 7 - 1) * 864e5);
  const trend = await harness(`${possessive(act.name)} weekly trend, last ${TREND_WEEKS} weeks`, "qloo_trends", { entities: [act.id], entity_type: t, start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10), limit: TREND_WEEKS });
  await harness(`Who is in ${possessive(act.name)} audience`, "qloo_audience_demographics", { entity: act.id, entity_type: t });

  const shared = overlap?.status === "ok" ? overlap.results.slice(0, 4).map((r) => r.name) : [];
  const cells = where.extra?.cells || 0;
  return {
    headline: cities.length
      ? `${possessive(act.name)} crowd is strongest in ${list(cities.slice(0, 3).map((c) => c.name))}.`
      : `Qloo's heatmap showed no city of 300k+ people for ${act.name} in ${input.region}.`,
    cities: cities.slice(0, 6).map((c) => ({
      city: c.name,
      why: `Qloo affinity ${c.affinity} at its strongest grid cell, higher than ${pct(c.beats)} of the ${cells.toLocaleString("en-US")} cells Qloo returned for ${input.region}${c.also?.length ? `. Same market: ${list(c.also)}` : ""}.`,
      evidence: [where.n],
    })),
    openers: order.slice(0, 3).map((o, i) => ({
      name: o.name,
      why: i === 0
        ? `${ranked?.status === "ok" ? `Ranked first of ${order.length} for this crowd, with ${top} as the location signal` : `Highest Qloo affinity with ${possessive(act.name)} fans`}${shared.length ? `. Shared Qloo tags: ${shared.join(", ")}` : ""}.`
        : ranked?.status === "ok" ? `Ranked ${i + 1} of ${order.length} for this crowd in ${top}.` : `Also high Qloo affinity with ${possessive(act.name)} fans.`,
      evidence: [peers.n, ranked?.status === "ok" ? ranked.n : null, i === 0 && overlap?.status === "ok" ? overlap.n : null].filter(Boolean),
    })),
    partners: partnerSteps.flatMap((s) => (s.status === "ok" ? s.results.slice(0, 2).map((p) => ({ city: s.args.filter_location, name: p.name, where: p.where || null, why: `Qloo affinity ${p.score ?? "n/a"} with ${possessive(act.name)} fans.`, evidence: [s.n] })) : [])),
    timing: timingText(trend, act),
    caveats: [
      "Qloo affinities describe aggregate audiences, not individual fans.",
      "Qloo's heatmap returns grid cells, not city names. Each stop is a city of 300k+ people (GeoNames), scored by the strongest Qloo cell within 30 km of its centre.",
      "Venue capacity, routing distances, ticket prices and promoter relationships are outside this data.",
    ],
  };
}

function trendPoints(steps) {
  const s = [...steps].reverse().find((x) => x.tool === "qloo_trends" && x.status === "ok");
  return (s?.extra?.series?.[0]?.points || []).filter((p) => p.rank != null);
}

function timingText(trend, act) {
  const pts = trend?.status === "ok" ? (trend.extra?.series?.[0]?.points || []).filter((p) => p.rank != null) : [];
  if (pts.length < 2) return "Qloo returned no trend data for this act, so timing rests on routing and venue availability.";
  const newest = pts[0], oldest = pts.at(-1); // newest first
  const change = (oldest.rank - newest.rank) / oldest.rank; // positive: the rank number fell, so the act rose
  const span = `from ${oldest.date} to ${newest.date}`;
  if (Math.abs(change) < 0.02) return `Steady: ${possessive(act.name)} weekly trending rank on Qloo stayed ${newest.rank === oldest.rank ? `at ${fmt(newest.rank)}` : `near ${fmt(newest.rank)}`} ${span}. The data gives no reason to rush or wait; book around routing and venue holds.`;
  if (change > 0) return `Rising: ${possessive(act.name)} weekly trending rank on Qloo improved from ${fmt(oldest.rank)} to ${fmt(newest.rank)} ${span}. Suggestion: book sooner while the trend is up.`;
  return `Cooling: ${possessive(act.name)} weekly trending rank on Qloo went from ${fmt(oldest.rank)} to ${fmt(newest.rank)} ${span}. Suggestion: favour smaller rooms, or tour behind new material.`;
}

function audienceText(steps, act) {
  const s = [...steps].reverse().find((x) => x.tool === "qloo_audience_demographics" && x.status === "ok");
  const d = s?.extra?.demographics;
  if (!d || (!d.age.length && !d.gender.length)) return null;
  const ages = d.age.filter((a) => a.value > 0).sort((a, b) => b.value - a.value).slice(0, 2).map((a) => a.band);
  const g = [...d.gender].sort((a, b) => b.value - a.value)[0];
  const parts = [];
  if (ages.length) parts.push(`over-indexes with ages ${list(ages)}`);
  if (g) parts.push(g.value >= 0.05 ? `leans ${g.band}` : "is close to even by gender");
  return parts.length ? { text: `${possessive(act.name)} audience ${parts.join(" and ")} (Qloo, aggregate).`, evidence: [s.n] } : null;
}

// Facts the poster shows next to the plan, taken straight from the steps.
function extras({ input, act, where, steps }) {
  const overlap = [...steps].reverse().find((x) => x.tool === "qloo_compare_audiences" && x.status === "ok");
  return {
    act: { name: act.name, id: act.id, tags: act.tags.slice(0, 6).map((t) => t.name), disambiguation: act.disambiguation },
    region: input.region,
    cells: where.extra?.cells || 0,
    cityStats: Object.fromEntries((where.extra?.cities || []).map((c) => [normName(c.name), { affinity: c.affinity, beats: c.beats, also: c.also || [], admin1: c.admin1 }])),
    hotspots: (where.extra?.hotspots || []).map((h) => ({ name: h.name, affinity: h.affinity, evidence: [where.n] })),
    shared: overlap ? { tags: overlap.results.slice(0, 5).map((r) => r.name), evidence: [overlap.n] } : null,
    trend: trendPoints(steps).map((p) => ({ date: p.date, rank: p.rank })),
    audience: audienceText(steps, act),
  };
}

// Drop anything in the plan whose name never appeared in a tool result.
export function ground(plan, steps) {
  const seen = new Set();
  for (const s of steps) for (const r of s.results || []) seen.add(norm(r.name));
  const max = steps.length;
  const ok = (name) => seen.has(norm(name));
  const dropped = [];
  const keep = (list, field, also) => (Array.isArray(list) ? list : []).filter((x) => {
    const y = x && ok(x[field]) && (!also || ok(x[also]));
    if (!y) dropped.push(x?.[field] ?? "(unnamed)");
    return y;
  }).map((x) => ({ ...x, evidence: (Array.isArray(x.evidence) ? x.evidence : []).filter((n) => Number.isInteger(n) && n >= 1 && n <= max) }));
  const out = {
    headline: String(plan.headline || ""),
    cities: keep(plan.cities, "city"),
    openers: keep(plan.openers, "name"),
    partners: keep(plan.partners, "name", "city"),
    timing: String(plan.timing || ""),
    caveats: (Array.isArray(plan.caveats) ? plan.caveats : []).map(String),
  };
  if (dropped.length) out.caveats.push(`Removed ${dropped.length} suggestion(s) the agent named without Qloo evidence: ${dropped.join(", ")}.`);
  return out;
}

const possessive = (s) => (/s$/i.test(s) ? `${s}'` : `${s}'s`);
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const list = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const pct = (x) => `${Math.floor((x ?? 0) * 1000) / 10}%`;
const fmt = (n) => Number(n).toLocaleString("en-US");
