# Where's My Crowd

**A tour-planning agent for independent musicians and comedians, grounded in Qloo's taste graph.**

Labels and big promoters pay data teams to know where an act's fans live, who shares their audience, and which local spots that crowd already loves. An independent act books a tour on guesswork and Instagram follower counts. Where's My Crowd gives that act the same picture, and turns it into a tour they can book: name the act (or an act you sound like) and a region, and the agent comes back with a routed tour (cities in travel order, drive or fly per leg, a day plan), the music or comedy rooms to pitch in each city, an opener who won't out-draw you, the places your crowd already hangs out for promotion, and a booking kit (a booking sheet and a pitch email per room). Every pick links to the Qloo call behind it.

> If you removed Qloo, this product would not exist. A language model can guess "Brooklyn and Austin" for any indie act; it cannot know that *this* act's audience over-indexes in Kochi and Shillong, or which café in Pune that same crowd loves. That is Qloo's taste graph.

## How it works

The agent works like a booking agent, one Qloo question at a time. Each question appears in the **booking log** as it happens, and every claim on the poster links back to the step that supports it.

Every Qloo call goes through Qloo's official harness (`@qloo/qloo-harness`), started as a subprocess on the server: its workflow tools (`qloo mcp`) for most steps, and its raw API server (`qloo api mcp`) for two steps where the workflow tools drop data the plan needs.

| Step | Qloo call (through the harness) | Why it fits |
|---|---|---|
| Who is this act? | `qloo_search` (raw API) | Resolve the name to exactly one Qloo entity, with its own tags; ask the user when several acts share the name |
| Where is the crowd? | `qloo_insights` `filter.type=urn:heatmap` (raw API) | Every grid cell of the region's heatmap (thousands for a country), folded into cities of 300k+ people. `qloo_where_popular` keeps only the top 20 cells, which for a whole country are mostly remote areas |
| Who to tour with? | `qloo_recommend` → `qloo_rank` (in the top city) → `qloo_compare_audiences` | Candidate acts, ranked for this audience in that city, with the overlap explained by shared tags |
| Local partners | `qloo_recommend` `target_type: place`, `filter_location` = city | Places this crowd loves in each top city: promo and after-show partners |
| Who is the audience? | `qloo_audience_demographics` | Age and gender affinities, for the poster's caveats and targeting |
| When to go | `qloo_trends` (last 20 weeks) | Momentum before fixing dates |
| Rooms to pitch | `qloo_recommend` `target_type: place` with Qloo's venue categories (`live_music_venue`, `concert_hall`, `live_music_bar`; `comedy_club` for comedians) | Real rooms this crowd already goes to, ranked by affinity. Generic place results gave a comedian the symphony and a museum; the categories give Punch Line and Cobb's |

**Booking layer** (`lib/booking.js`, plain rules over the Qloo results, so it never depends on the model):
- **Opener draw check:** Qloo popularity of each suggested opener against the headliner's. Someone who out-draws you is flagged as a co-headliner, not an opener.
- **Route:** the stops in travel order (nearest neighbour, then 2-opt), drive or fly per leg, and a day plan with travel and rest days.
- **Booking kit:** a CSV booking sheet and a pitch email per room, written only from Qloo numbers.
- **Map:** up to 1,500 of Qloo's heatmap cells drawn as a dot map with the route on top, as SVG from the plan's data, with no map tiles, so the visitor's browser contacts no third party.

**Agent:** with `GEMINI_API_KEY` set, Gemini decides which Qloo tools to call and in what order (function calling over the harness's own MCP tool schemas, budget of 12 Qloo calls). Without it, a fixed booking workflow runs the same steps.

**Grounding check:** before anything reaches the poster, every city, act and place the agent names is checked against the names Qloo actually returned. Anything else is removed, and the poster says what was removed.

### Example (request → result)
`Prateek Kuhad`, musician, India (live run, 18 Oct 2026) →
`qloo_search {query: "Prateek Kuhad", type: urn:entity:artist}` → one exact match →
`qloo_insights {type: urn:heatmap, signal_entities: <his Qloo ID>, filter_location: "India"}` → 3,100 grid cells → strongest cities Mumbai (0.994), Bengaluru (0.994), Pune (0.993) →
`qloo_recommend` + `qloo_rank` → openers The Local Train, Anuv Jain, Tajdar Junaid →
`qloo_recommend {target_type: "place", filter_location: "Mumbai"}` → places listed under that stop as crowd favourites.

## Responsible use
- Qloo receives only act names, regions and city names: never personal data.
- Results are presented as aggregate audience affinities, not facts about individual fans; the poster lists what the data does not establish.
- The Qloo key stays on the server (the harness runs as a subprocess); the browser never sees it. Results are cached for 6 hours and each visitor is rate-limited, to respect the event quota.

## Run it

Requires Node.js 22.19+.

```sh
npm install
cp .env.example .env    # add QLOO_API_KEY (and optionally GEMINI_API_KEY)
node --env-file=.env server.js
# open http://localhost:8787
```

Without `QLOO_API_KEY` the app runs on clearly-labelled **sample data**, for development only.

```sh
npm test   # grounding, schema conversion, result parsing, both agent modes
```

### Deploy
Qloo's harness needs a long-running Node process, so serverless hosts are not supported. Use any container host:
- **Render (free):** `render.yaml` is included. Create a Blueprint from this repo and set `QLOO_API_KEY` and `GEMINI_API_KEY` as secrets.
- **Docker:** `docker build -t wmc . && docker run -p 8080:8080 -e QLOO_API_KEY=… wmc`

## Limits
- Venue capacities, routing distances, promoter relationships and ticket prices are outside Qloo's data and outside this tool.
- Smaller acts may not be in Qloo yet. Use an act you sound like as the reference.
- Affinity scores from separate calls are not comparable (Qloo's own guidance), so the poster compares cities only within one `where_popular` call.

## Data credits
City names, coordinates and populations in `data/cities.json` come from [GeoNames](https://www.geonames.org) (cities15000), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Taste data comes from the Qloo API at request time and is not stored in this repository.

## License
MIT. Built for the Qloo Agentic Hackathon (2026).
