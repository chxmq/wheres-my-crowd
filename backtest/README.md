# Backtest: does the app pick the cities real tours played?

**Question.** For a real artist, are the US cities Where's My Crowd ranks highest the cities that artist actually played on tour?

**Answer, on 178 tours the ranking never saw:** of its top 8 cities, **77.9%** were played (within 60 km), against **70.6%** for "the 8 biggest US cities" and **70.2%** for the app's previous ranking. It beats the population list on 103 tours, ties on 43 and loses on 32.

| Top N cities | Biggest US cities | Previous ranking (strongest affinity cell) | **Current ranking (fit)** |
|---|---|---|---|
| 5 | 0.837 | 0.737 | 0.815 |
| 8 | 0.706 | 0.702 | **0.779** |
| 12 | 0.623 | 0.673 | **0.739** |

Precision at N on the 178 held-out tours. The first 5 are where every act plays the same giant metros; Qloo's value shows after them.

## What we changed because of it

The app used to rank cities by the single strongest Qloo heatmap cell near each city. The first 104 tours showed that this over-picks tourist towns (Las Vegas, Honolulu) and is no better than population. The app now ranks by **fit**: 60% the city's Qloo affinity for this crowd (as a percentile among the region's cities), 40% the city's size. The 60/40 weight was chosen on those 104 tours (`tours-dev.json`) and then measured once on 178 others (`tours-holdout.json`). The ranking code is `citiesFromHeatmap` in `lib/geo.js`; `eval.mjs` scores that exact function.

## Examples (held out, top 8)

- **Japanese Breakfast** (27 US cities played): 7 of 8, including Austin, Seattle and Portland; the population list gets 3 (it picks Houston, Phoenix, San Antonio).
- **Muna**: 7 of 8 vs 4. **girl in red**: 7 of 8 vs 4.
- Where it loses: stadium acts. **Luke Combs** played 13 stadiums; the app picks his strongest-affinity markets (Nashville, Charlotte, Louisville), the population list picks the stadium cities: 2 vs 5.

## Method

- **Ground truth:** every page in Wikipedia's "2022/2023/2024/2025 concert tours" categories (563 pages), read with `fetch_tours.py` (no key; one page every 3 s, cached). From each tour-dates table it keeps the US rows (city and country columns, rowspans expanded); tours with fewer than 8 US cities are dropped: **307 tours**.
- **Qloo:** each artist is resolved by exact name through the same harness path the app uses; ambiguous or missing names are skipped, never guessed. Then one heatmap call for the United States. Of 307 tours, 16 were skipped for names Qloo couldn't match exactly, 6 for an empty heatmap and 3 for too few US cities we could place on the map: 282 scored. Raw Qloo responses are not committed.
- **Scoring:** a city counts as played if any show was within 60 km. Every method gets the same candidates (the app's US tour cities: 300k+, metro-folded) and the same one-stop-per-market rule.
- **Split:** tours crawled first (104 usable) are the development set; the rest (178 usable) were fetched after the change was made.

## Limits

- US only (Wikipedia's tour tables are densest there); the same ranking is used for India, the UK, Canada and Australia without a separate test.
- Wikipedia lists mostly bigger acts than the independent artists the app is for. Bigger acts play the biggest cities, which favours the population list, so the gap for smaller acts may well be larger, but this test doesn't show it.
- Qloo's data may already reflect where artists toured, which would flatter any Qloo-based ranking. The previous ranking used the same data and did not beat population, so data alone doesn't explain the result.

## Run it

```
python3 fetch_tours.py                                   # Wikipedia -> tours.json (cached in cache/)
node --env-file=../.env eval.mjs fetch                    # Qloo heatmaps -> heat/ (one call per artist)
DEV=tours-dev.json TOURS=tours-holdout.json node eval.mjs score 8   # -> results-k8.json
```

Tour data from Wikipedia (CC BY-SA 4.0); city data from GeoNames (CC BY 4.0).
