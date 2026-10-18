import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { citiesFromHeatmap, geohash, metroRadiusKm, tourCities, km } from "../lib/geo.js";

const doc = JSON.parse(readFileSync(new URL("./fixtures/heatmap-nyc.json", import.meta.url), "utf8"));

test("geohash encoding matches Qloo's documented heatmap cell", () => {
  const p = doc.results.heatmap[0];
  assert.equal(geohash(p.location.latitude, p.location.longitude, 6), "dr5wct");
});

test("the documented NYC heatmap becomes one tour stop: New York City", () => {
  const out = citiesFromHeatmap(doc.results.heatmap, "United States");
  assert.equal(out.cells, 7);
  assert.equal(out.cities[0].name, "New York City");
  assert.equal(out.cities[0].affinity, 1);
  assert.equal(out.cities[0].beats, 0.857); // 6 of the 7 documented cells have lower affinity
  assert.equal(out.cities.length, 1);
  assert.deepEqual(out.hotspots, []);
});

test("one stop per market, and strong cells away from the stops are named after a nearby town", () => {
  const cell = (lat, lon, affinity) => ({ location: { latitude: lat, longitude: lon, geohash: geohash(lat, lon, 4) }, query: { affinity, popularity: 0.9 } });
  const points = [
    cell(37.7749, -122.4194, 0.99), // San Francisco
    cell(37.3382, -121.8863, 0.5),  // San Jose: same market as San Francisco, weaker for this crowd
    cell(47.6062, -122.3321, 0.97), // Seattle
    cell(35.5951, -82.5515, 0.995), // Asheville, NC: no 300k+ city within 80 km
    cell(40.0, -100.0, 0.1),
  ];
  const out = citiesFromHeatmap(points, "United States");
  assert.deepEqual(out.cities.map((c) => c.name), ["San Francisco", "Seattle"]);
  assert.deepEqual(out.cities[0].also, ["San Jose"]);
  assert.equal(out.hotspots.length, 1);
  assert.match(out.hotspots[0].name, /North Carolina$/);
});

test("cells without coordinates or affinity are ignored; unknown regions return nothing", () => {
  assert.deepEqual(citiesFromHeatmap([{ location: {} }, null, { query: { affinity: 1 } }], "United States").cities, []);
  assert.deepEqual(citiesFromHeatmap(doc.results.heatmap, "Atlantis").cities, []);
});

test("metro radius grows with population and is bounded", () => {
  assert.equal(metroRadiusKm(100_000), 10);
  assert.ok(Math.abs(metroRadiusKm(1_000_000) - 39.9) < 0.1);
  assert.equal(metroRadiusKm(20_000_000), 60);
});

test("tour cities fold suburbs into their metro (Brooklyn into New York City)", () => {
  const us = tourCities("United States", 500).map((c) => c.label);
  assert.ok(us.includes("New York City"));
  assert.ok(!us.includes("Brooklyn"));
  const nyc = tourCities("United States", 1)[0];
  assert.ok(km(nyc.lat, nyc.lon, 40.6782, -73.9442) < metroRadiusKm(nyc.population));
});
