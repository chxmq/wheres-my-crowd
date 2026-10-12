const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Plain-language names for each Qloo question the agent can ask.
const ASK = {
  qloo_describe: ["Who is this act?", (a) => `Resolve “${a.entity}”`],
  qloo_entity_tags: ["What defines the audience?", (a) => `Tags shared by ${(a.entities || []).join(", ")}`],
  qloo_where_popular: ["Where is the crowd?", (a) => `Where ${a.entity} has strong affinity within ${a.within}`],
  qloo_recommend: ["Who and what does this crowd love?", (a) => `${a.target_type === "place" ? "Places" : a.target_type === "brand" ? "Brands" : "Acts"} for fans of ${(a.signals || []).join(", ")}${a.filter_location ? ` in ${a.filter_location}` : ""}`],
  qloo_rank: ["Who fits best?", (a) => `Rank ${(a.options || []).length} acts for fans of ${(a.signals || []).join(", ")}${a.signal_location ? ` in ${a.signal_location}` : ""}`],
  qloo_compare_audiences: ["How much do the crowds overlap?", (a) => `${(a.group_a || []).join(", ")} vs ${(a.group_b || []).join(", ")}`],
  qloo_trends: ["Is the act rising?", (a) => `Popularity ${a.start_date} → ${a.end_date}`],
  qloo_audience_demographics: ["Who is in the audience?", (a) => `Demographics for ${a.entity}`],
  qloo_find_tags: ["Find the right concept", (a) => `Tags matching “${a.query}”`],
};

let lastPlan = null;

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

function stepEl(e) {
  const [title, q] = ASK[e.tool] || [e.tool, () => ""];
  const li = document.createElement("li");
  li.className = "step";
  li.id = `step-${e.n}`;
  li.dataset.status = "pending";
  li.innerHTML = `
    <div class="step-head">
      <span><span class="step-n">${e.n}</span><span class="step-title">${esc(title)}</span></span>
      <span class="step-status">asking…</span>
    </div>
    <p class="step-q">${esc(q(e.args || {}))} <span class="step-tool">${esc(e.tool)}</span></p>
    <div class="chips"></div>`;
  return li;
}

function fillStep(s) {
  const li = document.getElementById(`step-${s.n}`);
  if (!li) return;
  li.dataset.status = s.status;
  li.querySelector(".step-status").textContent = s.cached ? `${s.status} · cached` : s.status;
  const chips = s.results.slice(0, 8).map((r) => `<span class="chip">${esc(r.name)}${r.score != null ? `<i>${r.score}</i>` : ""}</span>`).join("");
  li.querySelector(".chips").innerHTML = chips || `<span class="chip">${esc(s.error?.code || s.summary || "no results")}</span>`;
}

function ev(nums) {
  return (nums || []).map((n) => `<button type="button" class="ev" data-step="${Number(n)}" aria-label="Show evidence step ${Number(n)}">${Number(n)}</button>`).join("");
}

function renderPoster(act, region, out) {
  const p = out.plan;
  lastPlan = { act, region, ...out };
  const partnersBy = {};
  for (const x of p.partners) (partnersBy[x.city.toLowerCase()] ||= []).push(x);
  const opener = p.openers[0];
  $("#poster").innerHTML = `
    <div>
      ${out.sample ? '<p><span class="sample-flag">Sample data. Add a Qloo key for real results.</span></p>' : ""}
      <h2 class="act">${esc(act)}</h2>
      <p class="headline">${esc(p.headline)}</p>
      ${opener ? `<p class="with">with special guest <span>${esc(opener.name)}</span>${ev(opener.evidence)}</p><p class="with-why">${esc(opener.why)}${p.openers.slice(1).length ? ` Also consider ${p.openers.slice(1).map((o) => esc(o.name)).join(" and ")}.` : ""}</p>` : ""}
    </div>
    <ol class="dates" aria-label="Tour stops, best first">
      ${p.cities.map((c, i) => {
        const partners = partnersBy[c.city.toLowerCase()] || [];
        return `<li class="date">
          <span class="date-n">${String(i + 1).padStart(2, "0")}</span>
          <div>
            <p class="date-city">${esc(c.city)}${ev(c.evidence)}</p>
            <p class="date-why">${esc(c.why)}</p>
            ${partners.length ? `<p class="date-partners">Crowd favourites nearby: ${partners.map((x) => `<b>${esc(x.name)}</b>${ev(x.evidence)}`).join(", ")}</p>` : ""}
          </div>
        </li>`;
      }).join("") || '<li class="date"><span></span><p class="date-why">No cities came back for this region. Try a nearby region or a better-known reference act.</p></li>'}
    </ol>
    <div class="poster-foot">
      <div><h3>When to go</h3><p>${esc(p.timing)}</p></div>
      <div><h3>What this data doesn’t tell you</h3><ul>${p.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>
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
    `${lastPlan.act}: tour plan (${lastPlan.region})`, p.headline, "",
    ...p.cities.map((c, i) => `${i + 1}. ${c.city}: ${c.why}`), "",
    ...(p.openers.length ? [`Tour with: ${p.openers.map((o) => o.name).join(", ")}`] : []),
    ...(p.partners.length ? [`Local partners: ${p.partners.map((x) => `${x.name} (${x.city})`).join(", ")}`] : []),
    `When: ${p.timing}`, "", "Planned with Where's My Crowd, grounded in Qloo.",
  ].join("\n");
  try { await navigator.clipboard.writeText(text); e.target.textContent = "Copied"; } catch { e.target.textContent = "Couldn’t copy"; }
});

$("#plan-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#form-error");
  err.hidden = true;
  const act = $("#act").value.trim();
  if (act.length < 2) { err.textContent = "Enter an act’s name."; err.hidden = false; $("#act").focus(); return; }
  const body = { act, kind: new FormData(e.target).get("kind"), region: $("#region").value, notes: $("#notes").value.trim() };
  const go = $("#go");
  go.disabled = true; go.textContent = "Planning…";
  $("#steps").innerHTML = ""; $("#log-empty").hidden = true; $("#poster-wrap").hidden = true;
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
        const ev = JSON.parse(line);
        if (ev.type === "call") $("#steps").append(stepEl(ev));
        else if (ev.type === "result") fillStep(ev.step);
        else if (ev.type === "thought") { const li = document.createElement("li"); li.className = "thought"; li.textContent = ev.text; $("#steps").append(li); }
        else if (ev.type === "plan") renderPoster(act, body.region, ev);
        else if (ev.type === "error") throw new Error(ev.message);
      }
    }
  } catch (x) {
    err.textContent = x.message; err.hidden = false;
  } finally {
    go.disabled = false; go.textContent = "Find my crowd";
  }
});

init();
