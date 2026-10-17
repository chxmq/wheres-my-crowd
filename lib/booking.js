// The booking layer: what an act needs to actually book the tour, computed from Qloo data with plain rules,
// so it never depends on the language model behaving. Three decisions:
//   rooms   which venues to pitch in each city: places in Qloo's music-venue or comedy-club categories,
//           ranked by affinity with this act's crowd
//   openers who can open without out-drawing the headliner (Qloo popularity), or co-headline if bigger
//   route   the order to play the cities in, with travel legs and a day-by-day skeleton
// It also writes the outputs a booker sends: a per-room pitch email and a booking sheet (CSV), using only
// numbers and names that came back from Qloo.
import { km } from "./geo.js";
import { TOOL_TYPE } from "./crowd.js";

// Qloo's own place categories for rooms an act can book. Asking Qloo for places of these categories,
// ranked by affinity with the act's crowd, beat every heuristic over generic place tags we tried:
// e.g. for Hasan Minhaj in San Francisco it returns Punch Line and Cobb's Comedy Club, where generic
// places gave the symphony and a museum.
export const ROOM_TAGS = {
  musician: ["urn:tag:category:place:live_music_venue", "urn:tag:category:place:concert_hall", "urn:tag:category:place:live_music_bar"],
  comedian: ["urn:tag:category:place:comedy_club"],
};
// Names that are never a room an act books a public show in, even if Qloo files them under a category.
const NOT_A_ROOM = /\b(hotel|resort|banquets?|lawns?|wedding|marriage hall|school|college|universit(y|ies)|institute|hospital|airport)\b/i;
// Promo partners should be places fans hang out (cafes, bars, record shops), not hotels.
export const NOT_A_PARTNER = /\b(hotel|resort|inn|suites|airport|hospital|hyatt|marriott|hilton|novotel|radisson|westin|sheraton|oberoi|ritz|four seasons|holiday inn|ibis|courtyard|taj (hotel|palace|lands)|itc (grand|maratha|gardenia))\b/i;

/** Rooms to pitch in one city, from a harness qloo_recommend step with ROOM_TAGS. Pure. */
// Within Qloo's category, a name that says what the room is beats a cafe or wine bar that hosts the odd night.
const ROOM_NAME = { comedian: /\b(comedy|comedians?|laughs?|improv|punch ?line|funny|stand-?up|cobb'?s)\b/i, musician: /\b(live|music|jazz|blues|unplugged|gig|concert|hall|stage|club)\b/i };
export function roomsFrom(step, n = 3, kind = "musician") {
  if (!step || step.status !== "ok") return [];
  const named = ROOM_NAME[kind] || ROOM_NAME.musician;
  const rows = (step.results || []).filter((r) => r.name && !NOT_A_ROOM.test(r.name));
  return [...rows.filter((r) => named.test(r.name)), ...rows.filter((r) => !named.test(r.name))].slice(0, n)
    .map((r) => ({ name: r.name, id: r.id || null, affinity: r.score ?? null, address: r.where || null, evidence: [step.n] }));
}

/** The harness call for one city's rooms (run through the planner so it appears in the booking log). */
export const roomsCall = (act, kind, city) => ({ target_type: "place", signals: [act.id], filter_location: city, include_tags: ROOM_TAGS[kind] || ROOM_TAGS.musician, limit: 6 });

/**
 * Check each suggested opener's draw against the headliner's, using Qloo popularity (0-1 percentile).
 * An opener who out-draws the headliner is a co-headliner, not an opener.
 */
export function openerFit(act, openers, popularityOf) {
  const mine = typeof act.popularity === "number" ? act.popularity : null;
  return openers.map((o) => {
    const theirs = popularityOf(o.name);
    let fit = "unknown", note = "Qloo returned no popularity for comparison.";
    if (mine != null && typeof theirs === "number") {
      const gap = Math.round((theirs - mine) * 100);
      if (gap > 8) { fit = "co-headline"; note = `Draws more than ${act.name} on Qloo (popularity ${theirs} vs ${mine}): pitch as a co-headliner, not an opener.`; }
      else if (gap < -40) { fit = "small"; note = `Much smaller draw (popularity ${theirs} vs ${mine}): a fair opener, but adds few tickets.`; }
      else { fit = "opener"; note = `Similar or smaller draw (popularity ${theirs} vs ${mine}): a natural opener.`; }
    }
    return { ...o, popularity: theirs ?? null, fit, fitNote: note };
  }).sort((a, b) => rankFit(a.fit) - rankFit(b.fit));
}
const rankFit = (f) => ({ opener: 0, small: 1, unknown: 2, "co-headline": 3 }[f] ?? 4);

// Average door-to-door road speeds used only to estimate drive times; flights above the threshold.
const ROAD_KMH = { India: 45, "United States": 85, "United Kingdom": 70, Canada: 85, Australia: 85 };
const FLY_KM = { India: 650, "United States": 700, "United Kingdom": 500, Canada: 700, Australia: 700 };

/** Order the cities to keep travel short (nearest neighbour from the strongest city, then 2-opt). */
export function routeTour(cities, region = "India") {
  const pts = cities.filter((c) => typeof c.lat === "number" && typeof c.lon === "number");
  if (pts.length <= 1) return { order: pts.map((c) => c.name), legs: [], days: pts.map((c, i) => ({ day: i + 1, city: c.name, travel: null })), totalKm: 0 };
  const d = (a, b) => km(a.lat, a.lon, b.lat, b.lon);
  const route = [pts[0]];
  const left = pts.slice(1);
  while (left.length) {
    const last = route.at(-1);
    left.sort((a, b) => d(last, a) - d(last, b));
    route.push(left.shift());
  }
  const len = (r) => r.slice(1).reduce((s, c, i) => s + d(r[i], c), 0);
  for (let improved = true; improved;) {
    improved = false;
    for (let i = 1; i < route.length - 1; i++) for (let j = i + 1; j < route.length; j++) {
      const cand = [...route.slice(0, i), ...route.slice(i, j + 1).reverse(), ...route.slice(j + 1)];
      if (len(cand) + 1e-6 < len(route)) { route.splice(0, route.length, ...cand); improved = true; }
    }
  }
  const speed = ROAD_KMH[region] || 70, fly = FLY_KM[region] || 650;
  const legs = route.slice(1).map((c, i) => {
    const dist = Math.round(d(route[i], c));
    return dist >= fly
      ? { from: route[i].name, to: c.name, km: dist, mode: "fly" }
      : { from: route[i].name, to: c.name, km: dist, mode: "drive", hours: Math.round((dist / speed) * 2) / 2 };
  });
  // One show a day; a travel day before any drive over 8 hours; a day off after every third show in a row.
  const days = []; let day = 1, run = 0;
  route.forEach((c, i) => {
    const leg = i ? legs[i - 1] : null;
    if (leg && leg.mode === "drive" && leg.hours > 8) days.push({ day: day++, city: null, travel: leg });
    days.push({ day: day++, city: c.name, travel: leg && !(leg.mode === "drive" && leg.hours > 8) ? leg : null });
    if (++run === 3 && i < route.length - 1) { days.push({ day: day++, city: null, travel: null, off: true }); run = 0; }
  });
  return { order: route.map((c) => c.name), legs, days, totalKm: Math.round(len(route)) };
}

/** A short pitch email to a room, using only Qloo facts the plan already holds. */
export function pitchEmail({ act, kind, city, room, stats, cells, region, opener, audience }) {
  const lines = [
    `Subject: ${act.name}: ${city} date on the ${region} tour`,
    "",
    `Hello ${room.name} team,`,
    "",
    `We're routing ${act.name}'s ${region} tour and ${city} is one of the strongest markets for the ${kind === "comedian" ? "comedy" : "music"} audience we draw.`,
  ];
  if (stats?.affinity != null) lines.push(`On Qloo's taste data, ${city}'s strongest area scores ${stats.affinity} affinity for this audience, higher than ${pctText(stats.beats)} of the ${Number(cells || 0).toLocaleString("en-US")} areas Qloo measured across ${region}.`);
  if (room.affinity != null) lines.push(`Your room is one of the places this same audience already goes to (Qloo affinity ${room.affinity}).`);
  if (opener) lines.push(`Planned support: ${opener.name}, whose fans overlap with ours.`);
  if (audience) lines.push(audience.replace(/ \(Qloo, aggregate\)\.$/, " (Qloo, aggregate)."));
  lines.push("", "Could you share available dates, capacity and terms for the window we're planning?", "", "Thanks,", `${act.name} booking`);
  return lines.join("\n");
}
const pctText = (x) => `${Math.floor((x ?? 0) * 1000) / 10}%`;

/** The booking sheet as CSV: one row per show day. */
export function bookingCsv(plan) {
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [["Day", "City", "Travel in", "Rooms to pitch (Qloo)", "Qloo city affinity", "Opener", "Promo partners (Qloo)"]];
  const roomsBy = Object.fromEntries((plan.rooms || []).map((r) => [r.city, r.rooms.map((x) => x.name).join("; ")]));
  const partnersBy = {};
  for (const p of plan.partners || []) (partnersBy[p.city] ||= []).push(p.name);
  const opener = plan.openers?.find((o) => o.fit === "opener" || o.fit === "small")?.name || "";
  for (const d of plan.route?.days || []) {
    if (!d.city) { rows.push([d.day, d.off ? "Day off" : "Travel", d.travel ? `${d.travel.from} → ${d.travel.to} (${d.travel.km} km)` : "", "", "", "", ""]); continue; }
    const stats = plan.cityStats?.[d.city.toLowerCase()];
    rows.push([d.day, d.city, d.travel ? `${d.travel.mode === "fly" ? "Fly" : `Drive ~${d.travel.hours} h`} from ${d.travel.from} (${d.travel.km} km)` : "Start", roomsBy[d.city] || "", stats?.affinity ?? "", opener, (partnersBy[d.city] || []).join("; ")]);
  }
  return rows.map((r) => r.map(esc).join(",")).join("\n");
}

export { TOOL_TYPE };
