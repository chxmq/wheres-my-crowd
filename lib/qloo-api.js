// Direct, read-only calls to documented Qloo endpoints. The app uses these where
// the harness's workflow tools drop data the planner needs:
//   /search          the act's own Qloo tags (the harness's describe drops them)
//   /v2/insights     urn:heatmap: every grid cell (where_popular keeps only the top 20,
//                    which for a whole country are mostly remote areas)
//   /v2/insights     filter.results.entities: rank a shortlist whose Qloo IDs we
//                    already hold, in one request (the harness re-resolves every ID)
// Everything else goes through the Qloo harness (lib/qloo.js).
// The key is sent only in the X-Api-Key header and is never logged.
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

export async function qlooGet(path, params = {}, { fetchImpl = globalThis.fetch, attempts = 2 } = {}) {
  if (SAMPLE_MODE) return sampleApi(path, params);
  const url = buildUrl(path, params);
  if (url.protocol !== "https:") throw new QlooHttpError(0, "Qloo base URL must use HTTPS.", path);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { Accept: "application/json", "X-Api-Key": process.env.QLOO_API_KEY || "" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new QlooHttpError(res.status, "Qloo response was larger than expected.", path);
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
      if (res.ok && body) return body;
      const message = body?.message || body?.error?.message || body?.error || body?.reason || `Qloo returned HTTP ${res.status}.`;
      throw new QlooHttpError(res.status, typeof message === "string" ? message : `Qloo returned HTTP ${res.status}.`, path);
    } catch (e) {
      lastError = e instanceof QlooHttpError ? e : new QlooHttpError(0, e.name === "TimeoutError" ? "Qloo did not respond in time." : "Could not reach Qloo.", path);
      if (!lastError.retryable || attempt === attempts) break;
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
  throw lastError;
}

export const provenance = (path, params, documentation) => ({
  source: SAMPLE_MODE ? "sample" : "Qloo API",
  transport: "direct",
  endpoint: path,
  documentation,
  requests: [{ method: "GET", path, query: params }],
});
