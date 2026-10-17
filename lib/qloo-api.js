// Raw Qloo API responses, fetched through the official harness's API server (`qloo api mcp`,
// part of @qloo/qloo-harness, one of the event's supported surfaces). The app uses it where the
// harness's workflow tools drop data the planner needs:
//   search        the act's own Qloo tags (the workflow's describe drops them)
//   insights      urn:heatmap: every grid cell (where_popular keeps only the top 20,
//                 which for a whole country are mostly remote areas)
// Everything else goes through the harness's workflow tools (lib/qloo.js, `qloo mcp`).
// The key lives in QLOO_API_KEY on the server and is never logged or sent to the browser.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sampleApi } from "./sample.js";

export const HACKATHON_API = "https://hackathon.api.qloo.com";
export const SAMPLE_MODE = process.env.MOCK === "1" || !process.env.QLOO_API_KEY;
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 12 * 1024 * 1024; // a country heatmap is about 1-2 MB

export class QlooHttpError extends Error {
  constructor(status, message, path) {
    super(message);
    this.name = "QlooHttpError";
    this.status = status;
    this.path = path;
    this.code = status === 401 || status === 403 ? "QLOO_AUTH" : status === 429 ? "QLOO_RATE_LIMIT" : status >= 500 ? "QLOO_UPSTREAM" : status ? "QLOO_REQUEST" : "QLOO_CONNECT";
    this.retryable = status === 429 || status >= 500 || !status;
  }
}

export function baseUrl() {
  return (process.env.QLOO_BASE_URL || HACKATHON_API).replace(/\/+$/, "");
}

// The documented GET query: arrays are comma-joined, empty values are left out.
export function buildUrl(path, params = {}) {
  const url = new URL(baseUrl() + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return url;
}

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", "qloo");
let rawPromise = null;

async function rawClient() {
  if (!rawPromise) rawPromise = (async () => {
    const client = new Client({ name: "wheres-my-crowd-raw", version: "0.2.0" });
    const base = baseUrl();
    // Hackathon keys only work against the hackathon API; the harness trusts it only when told to.
    const env = { ...process.env, QLOO_BASE_URL: base, QLOO_TRUSTED_BASE_URL: process.env.QLOO_TRUSTED_BASE_URL || base };
    const transport = new StdioClientTransport({ command: BIN, args: ["api", "mcp"], env, stderr: "pipe" });
    await client.connect(transport);
    transport.onclose = () => { rawPromise = null; };
    return client;
  })().catch((e) => { rawPromise = null; throw e; });
  return rawPromise;
}

async function harnessCall(tool, args) {
  return (await rawClient()).callTool({ name: tool, arguments: args }, undefined, { timeout: TIMEOUT_MS });
}
let call = harnessCall;
/** Tests replace the harness with a fake: fn(tool, args) → MCP CallToolResult. */
export function setRawCaller(fn) { call = fn || harnessCall; }

// The documented GET endpoints the app needs, as the harness API server's tools.
export function toTool(path, params = {}) {
  const csv = (v) => (Array.isArray(v) ? v.join(",") : v == null ? undefined : String(v));
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));
  if (path === "/search") return ["qloo_search", strip({ query: params.query, type: csv(params.types), take: csv(params.take) })];
  if (path === "/entities") return ["qloo_entity", strip({ id: csv(params.entity_ids) })];
  if (path === "/v2/insights") return ["qloo_insights", strip({ type: params["filter.type"], signal_entities: csv(params["signal.interests.entities"]), filter_location: params["filter.location.query"], signal_location: params["signal.location.query"], take: csv(params.take) })];
  throw new Error(`No harness route for ${path}`);
}

export async function qlooGet(path, params = {}, { attempts = 2 } = {}) {
  if (SAMPLE_MODE) return sampleApi(path, params);
  const [tool, args] = toTool(path, params);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await call(tool, args);
      const text = (res?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      if (text.length > MAX_BYTES) throw new QlooHttpError(0, "Qloo response was larger than expected.", path);
      if (res?.isError) {
        const status = Number((text.match(/\b(40[0-9]|429|5\d\d)\b/) || [])[1]) || 0;
        throw new QlooHttpError(status || 400, status ? `Qloo returned HTTP ${status}.` : "Qloo rejected the request.", path);
      }
      const body = JSON.parse(text);
      if (body) return body;
      throw new QlooHttpError(0, "Qloo returned an empty response.", path);
    } catch (e) {
      lastError = e instanceof QlooHttpError ? e : new QlooHttpError(0, /timed? ?out/i.test(e.message) ? "Qloo did not respond in time." : "Could not reach Qloo through the harness.", path);
      if (!lastError.retryable || attempt === attempts) break;
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
  throw lastError;
}

export const provenance = (path, params, documentation) => ({
  source: SAMPLE_MODE ? "sample" : "Qloo API",
  transport: "qloo api mcp",
  endpoint: path,
  documentation,
  requests: [{ method: "GET", path, query: params }],
});
