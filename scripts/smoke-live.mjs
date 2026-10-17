// Live smoke test for Where's My Crowd: one call per Qloo route the app uses, all through the
// official harness (the same code paths as the app), plus one Gemini tool call. Prints each
// result's status and a short shape summary. Never prints keys.
//
//   npm run smoke:live                                    # Prateek Kuhad, India
//   npm run smoke:live -- --act "Hasan Minhaj" --kind comedian --region "United States"
//   npm run smoke:live -- --plan                          # also run one full plan
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    act: { type: "string", default: "Prateek Kuhad" },
    kind: { type: "string", default: "musician" },
    region: { type: "string", default: "India" },
    plan: { type: "boolean", default: false },
  },
});
if (!process.env.QLOO_API_KEY) { console.error("Set QLOO_API_KEY in .env first."); process.exit(2); }

const { resolveAct, crowdCities, TOOL_TYPE } = await import("../lib/crowd.js");
const { callQloo } = await import("../lib/qloo.js");
const { planTour, geminiDeclarations } = await import("../lib/agent.js");

let failures = 0;
const t = async (label, fn) => {
  const t0 = Date.now();
  try {
    const s = await fn();
    const ok = ["ok", "partial", "degraded", "needs_input"].includes(s.status);
    if (!ok) failures++;
    console.log(`${ok ? "✔" : "✖"} ${label}: ${s.status} in ${Date.now() - t0} ms via ${s.provenance?.transport || "harness"}${s.summary ? ` | ${s.summary.slice(0, 120)}` : ""}`);
    for (const r of (s.results || []).slice(0, 3)) console.log(`     ${r.name}${r.score != null ? ` ${r.score}` : ""}`);
    return s;
  } catch (e) {
    failures++;
    console.log(`✖ ${label}: ${e.code || ""} ${e.message}`);
    return null;
  }
};

const who = await t(`resolve "${opt.act}"`, () => resolveAct({ act: opt.act, kind: opt.kind }));
const act = who?.extra?.act;
if (!act) { console.log("Stopping: the act did not resolve to one Qloo entity."); process.exit(1); }
const type = TOOL_TYPE[opt.kind];
await t(`heatmap for ${opt.region}`, () => crowdCities({ act, region: opt.region }));
const peers = await t("recommend similar acts", () => callQloo("qloo_recommend", { target_type: type, signals: [act.id], limit: 5 }));
const ids = (peers?.results || []).map((r) => r.id).filter(Boolean).slice(0, 3);
if (ids.length > 1) await t("rank them", () => callQloo("qloo_rank", { options: ids, option_type: type, signals: [act.id] }));
if (ids[0]) await t("compare audiences", () => callQloo("qloo_compare_audiences", { group_a: [act.id], group_b: [ids[0]], limit: 5 }));
await t("audience demographics", () => callQloo("qloo_audience_demographics", { entity: act.id, entity_type: type }));
const end = new Date(), start = new Date(end - 20 * 7 * 864e5);
await t("weekly trend", () => callQloo("qloo_trends", { entities: [act.id], entity_type: type, start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10), limit: 20 }));

if (process.env.GEMINI_API_KEY) {
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const decls = await geminiDeclarations();
  const t0 = Date.now();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: `Who else would ${act.name}'s fans like? Use a tool.` }] }], tools: [{ functionDeclarations: decls }], toolConfig: { functionCallingConfig: { mode: "ANY" } } }),
    signal: AbortSignal.timeout(30000),
  }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
  const body = await res.json().catch(() => ({}));
  const fc = body.candidates?.[0]?.content?.parts?.find((p) => p.functionCall)?.functionCall;
  if (!res.ok || !fc) failures++;
  console.log(`${res.ok && fc ? "✔" : "✖"} Gemini (${model}) with ${decls.length} tools: HTTP ${res.status} in ${Date.now() - t0} ms${fc ? `, first call ${fc.name}` : ` ${body.error?.message || ""}`}`);
} else {
  console.log("– Gemini: no GEMINI_API_KEY, skipped (the app uses its fixed workflow).");
}

if (opt.plan) {
  const t0 = Date.now();
  const out = await planTour({ act: opt.act, kind: opt.kind, region: opt.region }, () => {});
  console.log(`✔ full plan: ${out.mode} in ${((Date.now() - t0) / 1000).toFixed(1)} s | ${out.plan?.headline || "(needs a choice)"}`);
}
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
