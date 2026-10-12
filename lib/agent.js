// The tour-planning agent. With GEMINI_API_KEY set, Gemini chooses which Qloo tools
// to call and when; otherwise a fixed planner runs the same workflow. Either way,
// every name in the final plan must come from a Qloo result (grounding check).
import { callQloo, qlooTools, SAMPLE_MODE } from "./qloo.js";

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
export const AGENT_MODE = GEMINI_KEY ? "gemini" : "planner";
const MAX_TOOL_CALLS = 14;

const AGENT_TOOLS = ["qloo_describe", "qloo_entity_tags", "qloo_where_popular", "qloo_recommend", "qloo_rank", "qloo_compare_audiences", "qloo_trends", "qloo_audience_demographics", "qloo_find_tags"];

const PLAN_SCHEMA = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING", description: "One sentence: where this act's crowd is and the shape of the tour." },
    cities: { type: "ARRAY", description: "4-8 stops, best first. Names exactly as returned by qloo_where_popular.", items: { type: "OBJECT", properties: {
      city: { type: "STRING" }, why: { type: "STRING", description: "One sentence citing the Qloo evidence." }, evidence: { type: "ARRAY", items: { type: "INTEGER" }, description: "Step numbers of the tool calls that support this." } }, required: ["city", "why", "evidence"] } },
    openers: { type: "ARRAY", description: "1-3 acts to tour with, names exactly as returned by Qloo.", items: { type: "OBJECT", properties: {
      name: { type: "STRING" }, why: { type: "STRING" }, evidence: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["name", "why", "evidence"] } },
    partners: { type: "ARRAY", description: "Local places or brands in tour cities that this crowd loves, for promo or after-show events.", items: { type: "OBJECT", properties: {
      city: { type: "STRING" }, name: { type: "STRING" }, why: { type: "STRING" }, evidence: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["city", "name", "why", "evidence"] } },
    timing: { type: "STRING", description: "When to go, from the trends evidence, or say the evidence is inconclusive." },
    caveats: { type: "ARRAY", items: { type: "STRING" }, description: "What the data does not establish." },
  },
  required: ["headline", "cities", "openers", "partners", "timing", "caveats"],
};

const SYSTEM = `You are Where's My Crowd, a tour-planning agent for independent musicians and comedians.
Plan a tour using ONLY evidence from Qloo tools. Work like a booking agent:
1. Resolve the act (qloo_describe) and learn what characterises its audience (qloo_entity_tags).
2. Find where that audience concentrates inside the requested region (qloo_where_popular with "within" = the region).
3. Find acts with an overlapping audience to tour with (qloo_recommend with the same target type, then qloo_rank them, then confirm the best one with qloo_compare_audiences).
4. For the top 2-3 cities, find places this crowd loves (qloo_recommend target_type "place" with filter_location = the city) for promo partners or after-show events.
5. Check momentum with qloo_trends over the last 6 months.
Rules: never invent names, cities or numbers; use names exactly as tools return them. If a tool returns needs_input or empty, adjust and retry once, then move on. Qloo results are aggregate affinities, not facts about individuals; say so in caveats. Use at most ${MAX_TOOL_CALLS} tool calls, then call submit_tour_plan with step numbers as evidence.`;

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

async function gemini(contents, tools) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents,
      tools: [{ functionDeclarations: tools }],
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
      generationConfig: { temperature: 0.3 },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${data.error?.message || "request failed"}`);
  return data.candidates?.[0]?.content || { role: "model", parts: [] };
}

function compact(step) {
  // What the model sees from each tool call: enough to reason, small enough to stay cheap.
  return { step: step.n, status: step.status, summary: step.summary, error: step.error?.code || null, results: step.results.slice(0, 12) };
}

export async function planTour(input, emit) {
  const steps = [];
  const run = async (tool, args) => {
    const n = steps.length + 1;
    emit({ type: "call", n, tool, args });
    const r = await callQloo(tool, args);
    const step = { n, ...r };
    steps.push(step);
    emit({ type: "result", step });
    return step;
  };

  let plan;
  if (AGENT_MODE === "gemini") plan = await geminiAgent(input, run, emit);
  else plan = await fixedPlanner(input, run);

  const grounded = ground(plan, steps);
  return { plan: grounded, steps, mode: AGENT_MODE, sample: SAMPLE_MODE };
}

async function geminiAgent(input, run, emit) {
  const mcpTools = (await qlooTools()).filter((t) => AGENT_TOOLS.includes(t.name));
  const decls = mcpTools.map((t) => ({ name: t.name, description: t.description?.slice(0, 900), parameters: toGemini(t.inputSchema) }));
  decls.push({ name: "submit_tour_plan", description: "Submit the final tour plan. Call this exactly once, last.", parameters: PLAN_SCHEMA });

  const today = new Date().toISOString().slice(0, 10);
  const contents = [{ role: "user", parts: [{ text: `Plan a tour.\nAct: ${input.act}\nAct type: ${input.kind} (Qloo entity type "${input.kind === "comedian" ? "person" : "artist"}")\nRegion: ${input.region}\nToday: ${today}${input.notes ? `\nArtist's notes: ${input.notes}` : ""}` }] }];

  for (let calls = 0; calls <= MAX_TOOL_CALLS + 1; calls++) {
    const content = await gemini(contents, decls);
    contents.push(content);
    const fcs = (content.parts || []).filter((p) => p.functionCall);
    const text = (content.parts || []).filter((p) => p.text).map((p) => p.text).join(" ").trim();
    if (text) emit({ type: "thought", text: text.slice(0, 400) });
    if (!fcs.length) throw new Error("The agent stopped without a plan.");
    const responses = [];
    for (const { functionCall: fc } of fcs) {
      if (fc.name === "submit_tour_plan") return fc.args;
      if (!AGENT_TOOLS.includes(fc.name) || calls >= MAX_TOOL_CALLS) {
        responses.push({ functionResponse: { name: fc.name, response: { error: "Tool budget used up: call submit_tour_plan now." } } });
        continue;
      }
      const step = await run(fc.name, fc.args || {});
      responses.push({ functionResponse: { name: fc.name, response: compact(step) } });
    }
    contents.push({ role: "user", parts: responses });
  }
  throw new Error("The agent ran out of steps.");
}

// Same workflow without an LLM: deterministic, used when no Gemini key is configured.
async function fixedPlanner(input, run) {
  const type = input.kind === "comedian" ? "person" : "artist";
  const act = input.act;
  const d = await run("qloo_describe", { entity: act, type });
  const resolved = d.results[0]?.name || act;
  const tags = await run("qloo_entity_tags", { entities: [resolved], entity_type: type, limit: 6 });
  const where = await run("qloo_where_popular", { entity: resolved, entity_type: type, within: input.region, limit: 10 });
  const peers = await run("qloo_recommend", { target_type: type, signals: [resolved], limit: 10 });
  const options = peers.results.map((r) => r.name).filter((n) => n.toLowerCase() !== resolved.toLowerCase()).slice(0, 8);
  const topCity = where.results[0]?.name;
  const ranked = options.length ? await run("qloo_rank", { options, option_type: type, signals: [resolved], ...(topCity ? { signal_location: topCity } : {}) }) : null;
  const opener = ranked?.results[0]?.name;
  const overlap = opener ? await run("qloo_compare_audiences", { group_a: [resolved], group_b: [opener], limit: 6 }) : null;
  const partnerSteps = [];
  for (const c of where.results.slice(0, 3)) {
    partnerSteps.push(await run("qloo_recommend", { target_type: "place", signals: [resolved], filter_location: c.name, limit: 4 }));
  }
  const end = new Date(); const start = new Date(end); start.setMonth(start.getMonth() - 6);
  const trend = await run("qloo_trends", { entities: [resolved], entity_type: type, start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) });

  const tagWords = tags.results.slice(0, 3).map((t) => t.name).join(", ");
  return {
    headline: where.results.length
      ? `${possessive(resolved)} crowd is strongest in ${where.results.slice(0, 3).map((c) => c.name).join(", ")}${tagWords ? `, with an audience Qloo associates with ${tagWords}` : ""}.`
      : `Qloo didn't return enough location data for ${resolved} in ${input.region}.`,
    cities: where.results.slice(0, 6).map((c, i) => ({ city: c.name, why: `Rank ${i + 1} for affinity within ${input.region}${c.score != null ? ` (score ${c.score})` : ""}.`, evidence: [where.n] })),
    openers: (ranked?.results || []).slice(0, 3).map((o, i) => ({ name: o.name, why: i === 0 && overlap ? "Highest-ranked shared audience; overlap confirmed with an audience comparison." : "Ranked highly for the same audience.", evidence: [peers.n, ranked.n, ...(i === 0 && overlap ? [overlap.n] : [])] })),
    partners: partnerSteps.flatMap((s) => s.results.slice(0, 2).map((p) => ({ city: s.args.filter_location, name: p.name, why: "A place this act's fans have strong affinity for in this city.", evidence: [s.n] }))),
    timing: trend.results.length ? "Trend data returned for the last 6 months; check the momentum chart before fixing dates." : "Trend data was inconclusive for this act.",
    caveats: ["Qloo affinities describe aggregate audiences, not individual fans.", "Venue capacity, routing distances and local promoters are not part of this data."],
  };
}

// Drop anything in the plan whose name never appeared in a tool result.
export function ground(plan, steps) {
  const seen = new Set();
  for (const s of steps) for (const r of s.results) seen.add(norm(r.name));
  const ok = (name) => seen.has(norm(name));
  const dropped = [];
  const keep = (list, field) => (list || []).filter((x) => { const y = ok(x[field]); if (!y) dropped.push(x[field]); return y; });
  const out = {
    headline: String(plan.headline || ""),
    cities: keep(plan.cities, "city"),
    openers: keep(plan.openers, "name"),
    partners: keep(plan.partners, "name"),
    timing: String(plan.timing || ""),
    caveats: [...(plan.caveats || [])],
  };
  if (dropped.length) out.caveats.push(`Removed ${dropped.length} suggestion(s) the agent named without Qloo evidence: ${dropped.join(", ")}.`);
  return out;
}
const possessive = (s) => (/s$/i.test(s) ? `${s}'` : `${s}'s`);
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
