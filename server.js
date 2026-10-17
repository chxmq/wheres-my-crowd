import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { planTour, AGENT_MODE, PlanError } from "./lib/agent.js";
import { qlooStatus, SAMPLE_MODE } from "./lib/qloo.js";
import { REGION_NAMES } from "./lib/geo.js";
import { isUuid } from "./lib/crowd.js";

const app = express();
const PORT = Number(process.env.PORT) || 8787;
const ROOT = path.dirname(fileURLToPath(import.meta.url));

app.disable("x-powered-by");
app.set("trust proxy", 1); // Render and similar hosts sit behind one proxy; per-visitor limits need the client IP
app.use(express.json({ limit: "8kb" }));
app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  next();
});
app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));

// Health check for the host. It makes no Qloo request (qloo_capabilities is local).
app.get("/api/health", async (_req, res) => {
  res.json({ agent: AGENT_MODE, qloo: await qlooStatus(), regions: REGION_NAMES });
});

// A small per-IP budget protects the shared event quota.
const hits = new Map();
function allowed(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (list.length >= 12) return false;
  list.push(now);
  hits.set(ip, list);
  return true;
}

app.post("/api/plan", async (req, res) => {
  const act = String(req.body?.act || "").trim();
  const kind = req.body?.kind === "comedian" ? "comedian" : "musician";
  const region = REGION_NAMES.includes(req.body?.region) ? req.body.region : null;
  const notes = String(req.body?.notes || "").trim().slice(0, 240);
  const actId = req.body?.act_id ? String(req.body.act_id) : null;
  if (act.length < 2 || act.length > 80) return res.status(400).json({ error: "Enter the act's name (2–80 characters)." });
  if (!region) return res.status(400).json({ error: "Choose a region from the list." });
  if (actId && !isUuid(actId)) return res.status(400).json({ error: "That act choice is not valid. Search again." });
  if (!allowed(req.ip)) return res.status(429).json({ error: "That's the limit for this hour. Try again later." });

  res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  const emit = (event) => res.write(JSON.stringify(event) + "\n");
  emit({ type: "start", mode: AGENT_MODE, sample: SAMPLE_MODE });
  // Keep the stream alive through proxies while a model call is in flight; the page ignores pings.
  const ping = setInterval(() => emit({ type: "ping" }), 10000);
  try {
    const out = await planTour({ act, kind, region, notes, actId }, emit);
    if (!out.choose) emit({ type: "plan", ...out });
  } catch (e) {
    console.error("plan failed:", e.message);
    emit({ type: "error", message: e instanceof PlanError ? e.message : "Planning failed. Try again, or try a different spelling of the act." });
  } finally {
    clearInterval(ping);
  }
  res.end();
});

app.listen(PORT, () => {
  console.log(`Where's My Crowd on :${PORT} (agent: ${AGENT_MODE}, qloo: ${SAMPLE_MODE ? "sample data" : "live"})`);
});
