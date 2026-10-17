// Qloo workflow tools through the official harness (`qloo mcp`), started as a
// subprocess on this server. The key lives in QLOO_API_KEY and never reaches the browser.
// Result parsing follows the harness envelope (schema 1.0-preview.1) as checked
// against the hackathon API on 2026-10-16.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { sampleResult } from "./sample.js";
import { SAMPLE_MODE, HACKATHON_API } from "./qloo-api.js";

export { SAMPLE_MODE };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "node_modules", ".bin", "qloo");

let clientPromise = null;
let toolCache = null;

async function connect() {
  const client = new Client({ name: "wheres-my-crowd", version: "0.2.0" });
  // Hackathon keys only work against the hackathon API. The harness defaults to
  // production and trusts another base URL only when QLOO_TRUSTED_BASE_URL matches it.
  const base = process.env.QLOO_BASE_URL || HACKATHON_API;
  const env = {
    ...process.env,
    QLOO_BASE_URL: base,
    QLOO_TRUSTED_BASE_URL: process.env.QLOO_TRUSTED_BASE_URL || base,
    QLOO_HOME: process.env.QLOO_HOME || path.join(ROOT, ".qloo"), // harness state and logs stay in the app folder
  };
  const transport = new StdioClientTransport({ command: BIN, args: ["mcp"], env, stderr: "pipe" });
  await client.connect(transport);
  transport.onclose = () => { clientPromise = null; };
  return client;
}

async function client() {
  if (!clientPromise) clientPromise = connect().catch((e) => { clientPromise = null; throw e; });
  return clientPromise;
}

// MCP tool definitions, used to give the agent the exact Qloo schemas.
export async function qlooTools() {
  if (toolCache) return toolCache;
  if (SAMPLE_MODE) {
    // Schemas captured from @qloo/qloo-harness 0.1.26 (identical to its live tools/list).
    toolCache = JSON.parse(readFileSync(new URL("../fixtures/qloo-tools.json", import.meta.url), "utf8"));
    return toolCache;
  }
  const { tools } = await (await client()).listTools();
  toolCache = tools.filter((t) => t.name !== "qloo_capabilities");
  return toolCache;
}

// Qloo asks participants to cache what they need and keep requests minimal.
const cache = new Map();
const TTL = 6 * 60 * 60 * 1000;

export async function callQloo(name, args) {
  const key = `${name}:${JSON.stringify(args)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return { ...hit.value, cached: true };

  let envelope;
  if (SAMPLE_MODE) {
    envelope = sampleResult(name, args);
  } else {
    try {
      const res = await (await client()).callTool({ name, arguments: args });
      envelope = res.structuredContent ?? { status: "error", summary: "The Qloo harness returned no structured result.", error: { code: "UNKNOWN", retryable: false } };
    } catch (e) {
      envelope = { status: "error", summary: "Could not reach the Qloo harness.", error: { code: "HARNESS_UNAVAILABLE", retryable: true, recovery: e.message } };
    }
  }
  const value = normalize(name, args, envelope);
  if (["ok", "partial", "degraded"].includes(value.status)) cache.set(key, { at: Date.now(), value });
  return value;
}

const asArray = (v) => (Array.isArray(v) ? v : []);
const str = (...vs) => vs.find((v) => typeof v === "string" && v.trim()) ?? null;
const num = (...vs) => vs.find((v) => typeof v === "number" && Number.isFinite(v)) ?? null;
const r3 = (x) => Math.round(x * 1000) / 1000;
// Some Qloo names arrive HTML-encoded ("Bar &amp; Kitchen"); the UI escapes on output, so decode here once.
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
export const decode = (s) => (typeof s === "string" ? s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, k) => ENT[k]).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))) : s);

// One result row for the agent and the UI. Handles the harness's compact entity
// ({entity_id, name, type, subtype, popularity, affinity, properties}), compact tag
// ({id, name, type, popularity, affinity}) and raw Qloo tag ({tag_id, name, subtype, query}).
export function pick(r) {
  if (r == null) return null;
  if (typeof r !== "object") return { name: String(r) };
  const name = str(r.name, r.title, r.label, r.entity?.name, r.tag?.name);
  const id = str(r.entity_id, r.tag_id, r.id, r.entityId, r.tagId);
  if (!name && !id) return null;
  const out = { name: decode(name) || id };
  if (id) out.id = id;
  const score = num(r.affinity, r.query?.affinity, r.score, r.query?.score);
  if (score != null) out.score = r3(score);
  const kind = str(r.subtype, r.type);
  if (kind) out.kind = kind;
  const where = str(r.properties?.address, typeof r.address === "string" ? r.address : null);
  if (where) out.where = decode(where);
  if (typeof r.popularity === "number") out.popularity = r3(r.popularity);
  return out;
}

const AGE = { "24_and_younger": "24 and under", "25_to_29": "25–29", "30_to_34": "30–34", "35_to_44": "35–44", "45_to_54": "45–54", "55_and_older": "55 and over" };

// Reduce a harness envelope to what the agent and the UI need, keeping provenance.
export function normalize(name, args, env) {
  const e = env && typeof env === "object" ? env : {};
  const out = {
    tool: name,
    args,
    status: e.status || "error",
    summary: e.summary || "",
    warnings: asArray(e.warnings).slice(0, 5),
    error: e.error ? { code: e.error.code || "UNKNOWN", retryable: Boolean(e.error.retryable), recovery: e.error.recovery || "" } : null,
    provenance: e.provenance ? { source: e.provenance.source, endpoint: e.provenance.endpoint, documentation: e.provenance.documentation, transport: e.provenance.transport || e.execution?.transport || "mcp" } : null,
    sample: Boolean(e.sample),
    results: [],
    extra: {},
  };
  // needs_input: the harness could not pick one entity or tag; it lists candidates.
  const choices = asArray(e.resolution?.issues).flatMap((i) => asArray(i.candidates).map((c) => ({ id: c.id, name: c.name, type: c.type || null, description: c.description || null, field: i.field || null }))).filter((c) => c.id && c.name);
  if (choices.length) out.choices = choices.slice(0, 8);

  switch (name) {
    case "qloo_compare_audiences": {
      // results is an object: {tags: shared tags scored by query.score, a: tags of group A, b: tags of group B, matchEntities}
      const r = e.results && typeof e.results === "object" && !Array.isArray(e.results) ? e.results : {};
      out.results = (Array.isArray(e.results) ? e.results : asArray(r.tags)).map(pick).filter(Boolean).slice(0, 12);
      out.extra = { a: asArray(r.a).map((t) => t?.name).filter(Boolean).slice(0, 10), b: asArray(r.b).map((t) => t?.name).filter(Boolean).slice(0, 10) };
      break;
    }
    case "qloo_trends": {
      // series: [{entity, points}], points newest first: {date, population_rank (a string), population_percentile, ...}
      out.extra.series = asArray(e.series).map((s) => ({
        name: s?.entity?.name || null,
        id: s?.entity?.entityId || null,
        points: asArray(s?.points).map((p) => ({ date: str(p?.date), rank: Number.isFinite(Number(p?.population_rank)) ? Number(p.population_rank) : null, percentile: num(p?.population_percentile), velocity: num(p?.population_rank_velocity) })).filter((p) => p.date),
      }));
      break;
    }
    case "qloo_audience_demographics": {
      // results: [{entity_id, query: {age: {band: affinity}, gender: {male, female}}}]
      const q = asArray(e.results)[0]?.query || {};
      const age = Object.entries(q.age || {}).filter(([, v]) => typeof v === "number").map(([k, v]) => ({ band: AGE[k] || k, value: v }));
      const gender = Object.entries(q.gender || {}).filter(([, v]) => typeof v === "number").map(([k, v]) => ({ band: k, value: v }));
      out.extra.demographics = { age, gender };
      break;
    }
    case "qloo_where_popular": {
      // Heatmap cells carry coordinates, not names: name each by its geohash.
      out.results = asArray(e.results).map((p) => (p?.location ? { name: p.location.geohash || `${p.location.latitude},${p.location.longitude}`, score: num(p.query?.affinity) != null ? r3(p.query.affinity) : undefined, where: `${p.location.latitude}, ${p.location.longitude}` } : pick(p))).filter(Boolean).slice(0, 20);
      break;
    }
    default:
      out.results = asArray(e.results).map(pick).filter(Boolean).slice(0, 20);
  }
  return out;
}

export async function qlooStatus() {
  if (SAMPLE_MODE) return { mode: "sample", ready: true };
  try {
    const res = await (await client()).callTool({ name: "qloo_capabilities", arguments: {} }); // local; makes no Qloo request
    return { mode: "live", ready: Boolean(res.structuredContent?.adapter?.ready) };
  } catch (e) {
    return { mode: "live", ready: false, error: "harness unavailable" };
  }
}
