// Qloo access goes only through the official harness (`qloo mcp`), started as a
// subprocess on this server. The key lives in QLOO_API_KEY and never reaches the browser.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sampleResult } from "./sample.js";
import { readFileSync } from "node:fs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", "qloo");

const HACKATHON_API = "https://hackathon.api.qloo.com";
export const SAMPLE_MODE = process.env.MOCK === "1" || !process.env.QLOO_API_KEY;

let clientPromise = null;
let toolCache = null;

async function connect() {
  const client = new Client({ name: "wheres-my-crowd", version: "0.1.0" });
  // Hackathon keys only work against the hackathon API; the harness needs both URLs set to it.
  const base = process.env.QLOO_BASE_URL || HACKATHON_API;
  const env = { ...process.env, QLOO_BASE_URL: base, QLOO_TRUSTED_BASE_URL: process.env.QLOO_TRUSTED_BASE_URL || base };
  const transport = new StdioClientTransport({ command: BIN, args: ["mcp"], env, stderr: "pipe" });
  await client.connect(transport);
  transport.onclose = () => { clientPromise = null; };
  return client;
}

async function client() {
  if (!clientPromise) {
    clientPromise = connect().catch((e) => { clientPromise = null; throw e; });
  }
  return clientPromise;
}

// MCP tool definitions, used to give the agent the exact Qloo schemas.
export async function qlooTools() {
  if (toolCache) return toolCache;
  if (SAMPLE_MODE) {
    // Schemas captured from @qloo/qloo-harness 0.1.26, so sample mode needs no subprocess.
    toolCache = JSON.parse(readFileSync(new URL("../fixtures/qloo-tools.json", import.meta.url), "utf8"));
    return toolCache;
  }
  const { tools } = await (await client()).listTools();
  toolCache = tools.filter((t) => t.name !== "qloo_capabilities");
  return toolCache;
}

// Small cache: Qloo asks participants to cache what they need and keep requests minimal.
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
    const res = await (await client()).callTool({ name, arguments: args });
    envelope = res.structuredContent ?? { status: "error", summary: "No structured result", error: { code: "UNKNOWN", retryable: false } };
  }
  const value = normalize(name, args, envelope);
  if (value.status === "ok" || value.status === "partial" || value.status === "degraded") cache.set(key, { at: Date.now(), value });
  return value;
}

// Reduce a Qloo envelope to what the agent and the UI need, keeping provenance.
export function normalize(name, args, env) {
  const items = Array.isArray(env.results) ? env.results : Array.isArray(env.results?.entities) ? env.results.entities : [];
  return {
    tool: name,
    args,
    status: env.status || "error",
    summary: env.summary || "",
    warnings: env.warnings || [],
    error: env.error || null,
    provenance: env.provenance ? { source: env.provenance.source, endpoint: env.provenance.endpoint } : null,
    sample: Boolean(env.sample),
    results: items.slice(0, 20).map(pick),
  };
}

function pick(r) {
  if (!r || typeof r !== "object") return { name: String(r) };
  const name = r.name ?? r.entity?.name ?? r.title ?? r.label ?? r.locality?.name ?? r.query ?? r.tag ?? r.id;
  const score = r.affinity ?? r.score ?? r.query?.affinity ?? r.popularity ?? r.overlap ?? r.value ?? null;
  const out = { name: name != null ? String(name) : "(unnamed)" };
  if (typeof score === "number") out.score = Math.round(score * 1000) / 1000;
  const id = r.entity_id ?? r.id ?? r.urn;
  if (id && typeof id === "string") out.id = id;
  const kind = r.subtype ?? r.type ?? r.entity?.type;
  if (kind && typeof kind === "string") out.kind = kind;
  const where = r.location ?? r.properties?.address ?? r.address;
  if (where && typeof where === "string") out.where = where;
  if (Array.isArray(r.tags)) out.tags = r.tags.slice(0, 5).map((t) => t.name ?? t).filter((t) => typeof t === "string");
  return out;
}

export async function qlooStatus() {
  if (SAMPLE_MODE) return { mode: "sample", ready: true };
  try {
    const res = await (await client()).callTool({ name: "qloo_capabilities", arguments: {} });
    return { mode: "live", ready: Boolean(res.structuredContent?.adapter?.ready) };
  } catch (e) {
    return { mode: "live", ready: false, error: e.message };
  }
}
