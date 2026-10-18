import { test } from "node:test";
import assert from "node:assert/strict";
import { openerFit, routeTour, roomsFrom, pitchEmail, bookingCsv, ROOM_TAGS, roomsCall } from "../lib/booking.js";

test("an opener who out-draws the headliner is flagged as a co-headliner and sorted last", () => {
  const pop = { "Big Star": 0.99, "Peer": 0.84, "Tiny": 0.3 };
  const out = openerFit({ name: "Act", popularity: 0.85 }, [{ name: "Big Star" }, { name: "Peer" }, { name: "Tiny" }], (n) => pop[n]);
  assert.deepEqual(out.map((o) => [o.name, o.fit]), [["Peer", "opener"], ["Tiny", "small"], ["Big Star", "co-headline"]]);
  assert.match(out.at(-1).fitNote, /co-headliner/);
});

test("unknown popularity is said, not guessed", () => {
  const [o] = openerFit({ name: "Act" }, [{ name: "X" }], () => undefined);
  assert.equal(o.fit, "unknown");
});

test("the route keeps travel short and adds travel and rest days", () => {
  const cities = [
    { name: "Mumbai", lat: 19.07, lon: 72.88 }, { name: "Kolkata", lat: 22.57, lon: 88.36 },
    { name: "Pune", lat: 18.52, lon: 73.86 }, { name: "Bengaluru", lat: 12.97, lon: 77.59 }, { name: "Delhi", lat: 28.65, lon: 77.23 },
  ];
  const r = routeTour(cities, "India");
  assert.equal(r.order[0], "Mumbai");
  assert.equal(r.order[1], "Pune"); // the 150 km neighbour comes next, not Kolkata
  assert.ok(r.legs.find((l) => l.from === "Mumbai").mode === "drive");
  assert.ok(r.legs.some((l) => l.mode === "fly"));
  assert.ok(r.days.some((d) => d.off), "a day off after three shows in a row");
  assert.equal(r.days.filter((d) => d.city).length, 5);
});

test("rooms come from the Qloo category lookup, minus places that are never a room", () => {
  const step = { n: 12, status: "ok", results: [{ name: "Punch Line San Francisco", score: 0.832 }, { name: "Grand Hotel Ballroom", score: 0.9 }, { name: "Cobb's Comedy Club", score: 0.825 }] };
  assert.deepEqual(roomsFrom(step, 3, "comedian").map((r) => [r.name, r.evidence[0]]), [["Punch Line San Francisco", 12], ["Cobb's Comedy Club", 12]]);
  assert.deepEqual(roomsFrom({ status: "empty", results: [] }), []);
  const sf = { n: 3, status: "ok", results: [{ name: "Atlas Cafe" }, { name: "Shelton Theater" }, { name: "Punch Line San Francisco" }, { name: "Cobb's Comedy Club" }] };
  assert.deepEqual(roomsFrom(sf, 3, "comedian").map((r) => r.name), ["Punch Line San Francisco", "Cobb's Comedy Club", "Atlas Cafe"]);
  assert.deepEqual(roomsFrom({ n: 4, status: "ok", results: [{ name: "Pruneyard Cinemas" }, { name: "San Jose Improv" }] }, 3, "comedian").map((r) => r.name), ["San Jose Improv"], "a cinema is not a room to pitch");
  assert.deepEqual(roomsCall({ id: "A" }, "comedian", "Seattle").include_tags, ROOM_TAGS.comedian);
});

test("the pitch email and booking sheet use only the numbers they are given", () => {
  const mail = pitchEmail({ act: { name: "Act" }, kind: "musician", city: "Pune", room: { name: "Godaam", affinity: 0.95 }, stats: { affinity: 0.993, beats: 0.992 }, cells: 3100, region: "India", opener: { name: "Peer" }, audience: null });
  assert.match(mail, /0\.993 affinity/); assert.match(mail, /99\.2%/); assert.match(mail, /3,100 areas/); assert.match(mail, /Godaam/);
  const csv = bookingCsv({ route: { days: [{ day: 1, city: "Pune", travel: null }, { day: 2, city: null, off: true }] }, rooms: [{ city: "Pune", rooms: [{ name: "Godaam, Pune" }] }], cityStats: { pune: { affinity: 0.993 } }, openers: [{ name: "Peer", fit: "opener" }], partners: [] });
  assert.match(csv, /^Day,City/); assert.match(csv, /"Godaam, Pune"/); assert.match(csv, /Day off/);
});
