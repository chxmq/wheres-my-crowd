import { test } from "node:test";
import assert from "node:assert/strict";
import { citiesFromHeatmap } from "../lib/geo.js";

const pt = (latitude, longitude, affinity, popularity) => ({ location: { latitude, longitude }, query: { affinity, popularity } });

test("cities rank by fit: 60% Qloo affinity percentile, 40% city size", () => {
  const points = [
    pt(40.71, -74.0, 0.95, 0.98),   // New York: biggest, lowest affinity  -> 0.6*0   + 0.4*1   = 0.4
    pt(34.05, -118.24, 0.99, 0.40), // Los Angeles: top affinity, 2nd size -> 0.6*1   + 0.4*0.5 = 0.8
    pt(41.88, -87.63, 0.97, 0.70),  // Chicago: middle affinity, smallest -> 0.6*0.5 + 0.4*0   = 0.3
  ];
  const { cities } = citiesFromHeatmap(points, "United States", { limit: 3 });
  assert.deepEqual(cities.map((c) => c.name), ["Los Angeles", "New York City", "Chicago"]);
  assert.deepEqual(cities.map((c) => c.fit), [0.8, 0.4, 0.3]);
  assert.equal(cities[1].affinity, 0.95, "affinity is still reported for each city");
});
