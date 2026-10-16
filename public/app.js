const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Plain-language titles for each question the agent asks Qloo.
const TITLE = {
  qloo_resolve: "Who is this act?",
  qloo_crowd_cities: "Where is the crowd?",
  qloo_recommend: "Who and what does this crowd love?",
  qloo_rank: "Who fits best?",
  qloo_compare_audiences: "How much do the crowds overlap?",
  qloo_trends: "Is the act rising?",
  qloo_audience_demographics: "Who is in the audience?",
  qloo_find_tags: "Find the right concept",
};

let lastPlan = null;
let chosen = null; // {id, name} when the user picked one of several Qloo matches

async function init() {
  try {
    const h = await (await fetch("/api/health")).json();
    $("#region").innerHTML = h.regions.map((r) => `<option ${r === "United States" ? "selected" : ""}>${esc(r)}</option>`).join("");
    const sample = h.qloo?.mode === "sample";
    $("#mode").innerHTML = `Agent: <b>${h.agent === "gemini" ? "Gemini, choosing Qloo tools itself" : "fixed booking workflow"}</b>. Data: ${sample ? '<span class="sample-flag">sample data</span> (Qloo key not configured)' : "<b>live Qloo</b>"}.`;
  } catch {
    $("#mode").textContent = "Couldn’t reach the server.";
  }
}

function via(p) {
  if (!p) return "";
  const how = p.transport === "direct" ? "direct" : "Qloo harness (MCP)";
  return `${p.source === "sample" ? "sample data" : `GET ${p.endpoint || ""}`} · ${how}`;
}

function stepEl(e) {
  const li = document.createElement("li");
  li.className = "step";
  li.id = `step-${e.n}`;
  li.dataset.status = "pending";
  li.innerHTML = `
    <div class="step-head">
      <span><span class="step-n">${e.n}</span><span class="step-title">${esc(TITLE[e.tool] || e.tool)}</span></span>
      <span class="step-status">asking…</span>
    </div>
    <p class="step-q">${esc(e.label || "")} <span class="step-tool">${esc(e.tool)}</span></p>
    <div class="chips"></div>
    <p class="step-via"></p>`;
  return li;
}

function fillStep(s) {
  const li = document.getElementById(`step-${s.n}`);
  if (!li) return;
  li.dataset.status = s.status;
  li.querySelector(".step-status").textContent = s.cached ? `${s.status} · cached` : s.status.replace("_", " ");
  let chips = s.results.slice(0, 8).map((r) => `<span class="chip">${esc(r.name)}${r.score != null ? `<i>${r.score}</i>` : ""}</span>`).join("");
  const pts = s.extra?.series?.[0]?.points;
  if (!chips && pts?.length) chips = `<span class="chip">${pts.length} weekly points, ${esc(pts.at(-1).date)} to ${esc(pts[0].date)}</span>`;
  if (!chips && s.extra?.demographics) chips = `<span class="chip">age and gender affinities</span>`;
  if (!chips && s.choices?.length) chips = `<span class="chip">${s.choices.length} possible matches</span>`;
  li.querySelector(".chips").innerHTML = chips || `<span class="chip">${esc(s.error?.code || s.summary || "no results")}</span>`;
  li.querySelector(".step-via").textContent = [s.summary && s.status === "ok" ? s.summary : "", via(s.provenance)].filter(Boolean).join(" · ");
}

function ev(nums) {
  return (nums || []).map((n) => `<button type="button" class="ev" data-step="${Number(n)}" aria-label="Show evidence step ${Number(n)}">${Number(n)}</button>`).join("");
}

// Qloo's weekly trending rank, oldest to newest; a lower rank is better, so up means rising.
function sparkline(points) {
  if (!points || points.length < 2) return "";
  const pts = [...points].reverse();
  const ranks = pts.map((p) => p.rank);
  const lo = Math.min(...ranks), hi = Math.max(...ranks), w = 240, h = 48;
  const y = (r) => (hi === lo ? h / 2 : 4 + ((r - lo) / (hi - lo)) * (h - 8));
  const d = pts.map((p, i) => `${((i / (pts.length - 1)) * w).toFixed(1)},${y(p.rank).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Weekly trending rank from ${esc(pts[0].date)} to ${esc(pts.at(-1).date)}: ${esc(ranks[0])} to ${esc(ranks.at(-1))}"><polyline points="${d}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
}

function renderChoices(e, body) {
  const box = $("#choices");
  box.innerHTML = `<p><b>Qloo knows more than one match for “${esc(e.act)}”.</b> Which one is it?</p>
    <div class="choice-list">${e.candidates.map((c, i) => `<button type="button" class="choice" data-i="${i}"><b>${esc(c.name)}</b>${c.description ? `<span>${esc(c.description)}</span>` : ""}</button>`).join("")}</div>`;
  box.hidden = false;
  box.querySelectorAll(".choice").forEach((b) => b.addEventListener("click", () => {
    const c = e.candidates[Number(b.dataset.i)];
    chosen = { id: c.id, name: c.name };
    $("#act").value = c.name;
    box.hidden = true;
    submit({ ...body, act: c.name, act_id: c.id });
  }));
}

function renderPoster(out) {
  const p = out.plan;
  lastPlan = out;
  const partnersBy = {};
  for (const x of p.partners) (partnersBy[x.city.toLowerCase()] ||= []).push(x);
  const opener = p.openers[0];
  const stat = (c) => p.cityStats?.[c.toLowerCase().replace(/\s+/g, " ").trim()];
  $("#poster").innerHTML = `
    <div>
      ${out.sample ? '<p><span class="sample-flag">Sample data. Add a Qloo key for real results.</span></p>' : ""}
      <h2 class="act">${esc(p.act?.name)}</h2>
      ${p.act?.tags?.length ? `<p class="tags">Qloo tags: ${p.act.tags.map(esc).join(" · ")}</p>` : ""}
      <p class="headline">${esc(p.headline)}</p>
      ${opener ? `<p class="with">with special guest <span>${esc(opener.name)}</span>${ev(opener.evidence)}</p><p class="with-why">${esc(opener.why)}${p.openers.slice(1).length ? ` Also consider ${p.openers.slice(1).map((o) => esc(o.name)).join(" and ")}.` : ""}</p>` : ""}
    </div>
    <ol class="dates" aria-label="Tour stops, best first">
      ${p.cities.map((c, i) => {
        const partners = partnersBy[c.city.toLowerCase()] || [];
        const s = stat(c.city);
        return `<li class="date">
          <span class="date-n">${String(i + 1).padStart(2, "0")}</span>
          <div>
            <p class="date-city">${esc(c.city)}${s?.admin1 ? `<small>${esc(s.admin1)}</small>` : ""}${ev(c.evidence)}</p>
            <p class="date-why">${esc(c.why)}</p>
            ${partners.length ? `<p class="date-partners">Crowd favourites: ${partners.map((x) => `<b>${esc(x.name)}</b>${ev(x.evidence)}`).join(", ")}</p>` : ""}
          </div>
        </li>`;
      }).join("") || '<li class="date"><span></span><p class="date-why">No cities came back for this region. Try a nearby region or a better-known reference act.</p></li>'}
    </ol>
    <div class="poster-foot">
      <div><h3>When to go</h3>${sparkline(p.trend)}<p>${esc(p.timing)}</p></div>
      <div>
        ${p.audience ? `<h3>Who is in the crowd</h3><p>${esc(p.audience.text)}${ev(p.audience.evidence)}</p>` : ""}
        ${p.hotspots?.length ? `<h3>Also strong, outside these cities</h3><p>${p.hotspots.map((h) => `${esc(h.name)} (${h.affinity})`).join("; ")}${ev(p.hotspots[0].evidence)}. Small places and travel destinations can score high on relative affinity; check local capacity.</p>` : ""}
      </div>
      <div class="caveats"><h3>What this data doesn’t tell you</h3><ul>${p.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>
    </div>`;
  $("#poster-wrap").hidden = false;
  $("#poster-wrap").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

$("#poster").addEventListener("click", (e) => {
  const b = e.target.closest(".ev");
  if (!b) return;
  const li = document.getElementById(`step-${b.dataset.step}`);
  if (!li) return;
  li.scrollIntoView({ behavior: "smooth", block: "center" });
  li.classList.add("flash");
  setTimeout(() => li.classList.remove("flash"), 1600);
});

$("#copy-plan").addEventListener("click", async (e) => {
  if (!lastPlan) return;
  const p = lastPlan.plan;
  const text = [
    `${p.act?.name}: tour plan (${p.region})`, p.headline, "",
    ...p.cities.map((c, i) => `${i + 1}. ${c.city}: ${c.why}`), "",
    ...(p.openers.length ? [`Tour with: ${p.openers.map((o) => o.name).join(", ")}`] : []),
    ...(p.partners.length ? [`Local partners: ${p.partners.map((x) => `${x.name} (${x.city})`).join(", ")}`] : []),
    ...(p.hotspots?.length ? [`Also strong: ${p.hotspots.map((h) => h.name).join("; ")}`] : []),
    ...(p.audience ? [p.audience.text] : []),
    `When: ${p.timing}`, "", "Planned with Where's My Crowd, grounded in Qloo. City names: GeoNames (CC BY 4.0).",
  ].join("\n");
  try { await navigator.clipboard.writeText(text); e.target.textContent = "Copied"; } catch { e.target.textContent = "Couldn’t copy"; }
});

async function submit(body) {
  const err = $("#form-error");
  err.hidden = true;
  const go = $("#go");
  go.disabled = true; go.textContent = "Planning…";
  $("#steps").innerHTML = ""; $("#log-empty").hidden = true; $("#poster-wrap").hidden = true; $("#choices").hidden = true;
  try {
    const res = await fetch("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "Planning failed."); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        if (e.type === "call") $("#steps").append(stepEl(e));
        else if (e.type === "result") fillStep(e.step);
        else if (e.type === "thought" || e.type === "note") { const li = document.createElement("li"); li.className = "thought"; li.textContent = e.text; $("#steps").append(li); }
        else if (e.type === "choose") renderChoices(e, body);
        else if (e.type === "plan") renderPoster(e);
        else if (e.type === "error") throw new Error(e.message);
      }
    }
  } catch (x) {
    err.textContent = x.message; err.hidden = false;
  } finally {
    go.disabled = false; go.textContent = "Find my crowd";
  }
}

$("#act").addEventListener("input", () => { chosen = null; });

$("#plan-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const act = $("#act").value.trim();
  if (act.length < 2) { $("#form-error").textContent = "Enter an act’s name."; $("#form-error").hidden = false; $("#act").focus(); return; }
  const body = { act, kind: new FormData(e.target).get("kind"), region: $("#region").value, notes: $("#notes").value.trim() };
  if (chosen && chosen.name === act) body.act_id = chosen.id;
  submit(body);
});

document.querySelector(".examples")?.addEventListener("click", (e) => {
  const b = e.target.closest(".ex");
  if (!b) return;
  chosen = null;
  $("#act").value = b.dataset.act;
  $("#region").value = b.dataset.region;
  document.querySelector(`input[name="kind"][value="${b.dataset.kind}"]`).checked = true;
  $("#plan-form").requestSubmit();
});

init();
