// Builds data/cities.json, the gazetteer used to name Qloo heatmap grid cells.
//
// Source: GeoNames (https://www.geonames.org), licensed CC BY 4.0.
//   curl -O https://download.geonames.org/export/dump/cities15000.zip && unzip cities15000.zip
//   curl -O https://download.geonames.org/export/dump/admin1CodesASCII.txt
//   node scripts/build-cities.mjs <folder containing both files>
//
// Output: { "<country code>": [[name, admin1 name, lat, lon, population], ...] },
// populated places of 15,000+ people, largest first. Neighbourhood entries (PPLX)
// and historical or abandoned places are excluded.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COUNTRIES = ["IN", "US", "GB", "CA", "AU"];
const SKIP = new Set(["PPLX", "PPLH", "PPLQ", "PPLW", "PPLCH"]);
// GeoNames entries that carry a district's population, or that duplicate a city
// under a locality name (Rasapūdipalem is in Visakhapatnam, Kanayannur in Kochi).
const DROP = { IN: new Set(["Rasapūdipalem", "Kanayannur", "Kallakurichi", "Nowrangapur", "Gauriganj", "Punāsa"]) };
const dir = process.argv[2];
if (!dir) {
  console.error("Usage: node scripts/build-cities.mjs <folder with cities15000.txt and admin1CodesASCII.txt>");
  process.exit(2);
}

const admin1 = new Map();
for (const line of readFileSync(path.join(dir, "admin1CodesASCII.txt"), "utf8").split("\n")) {
  const [code, name] = line.split("\t");
  if (code && name) admin1.set(code, name);
}

const out = Object.fromEntries(COUNTRIES.map((c) => [c, []]));
for (const line of readFileSync(path.join(dir, "cities15000.txt"), "utf8").split("\n")) {
  const f = line.split("\t");
  if (f.length < 15) continue;
  const [, name, , , lat, lon, , feature, country, , a1, , , , pop] = f;
  if (!out[country] || SKIP.has(feature) || DROP[country]?.has(name)) continue;
  out[country].push([name, admin1.get(`${country}.${a1}`) || "", Number(Number(lat).toFixed(4)), Number(Number(lon).toFixed(4)), Number(pop)]);
}
for (const c of COUNTRIES) out[c].sort((a, b) => b[4] - a[4]);

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "cities.json");
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify({ source: "GeoNames cities15000 (https://www.geonames.org), CC BY 4.0", countries: out }));
console.log(`Wrote ${target}: ${COUNTRIES.map((c) => `${c} ${out[c].length}`).join(", ")}`);
