# Where's My Crowd

**A tour-planning agent for independent musicians and comedians, grounded in Qloo's taste graph.**

Labels and big promoters pay data teams to know where an act's fans live, who shares their audience, and which local spots that crowd already loves. An independent act books a tour on guesswork and Instagram follower counts. Where's My Crowd gives that act the same picture: name the act (or an act you sound like) and a region, and the agent comes back with a tour poster: ranked cities, who to tour with, the local places your crowd loves in each stop, and the evidence behind every pick.

> If you removed Qloo, this product would not exist. A language model can guess "Brooklyn and Austin" for any indie act; it cannot know that *this* act's audience over-indexes in Kochi and Shillong, or which café in Pune that same crowd loves. That is Qloo's taste graph.

## How it works

The agent works like a booking agent, one Qloo question at a time. Each question appears in the **booking log** as it happens, and every claim on the poster links back to the step that supports it.

| Step | Qloo tool | Why it fits |
|---|---|---|
| Who is this act? | `qloo_describe` | Resolve the name to one Qloo entity before relying on it |
| What defines the audience? | `qloo_entity_tags` | Concepts shared by the audience, used to explain picks |
| Where is the crowd? | `qloo_where_popular` (`within` = region) | Geographic affinity: the core of a tour plan |
| Who to tour with? | `qloo_recommend` → `qloo_rank` (in the top city) → `qloo_compare_audiences` | Candidate acts, ranked for this audience, with the overlap confirmed |
| Local partners | `qloo_recommend` `target_type: place`, `filter_location` = city | Places this crowd loves in each top city: promo and after-show partners |
| When to go | `qloo_trends` (last 6 months) | Momentum before fixing dates |

**Agent:** with `GEMINI_API_KEY` set, Gemini decides which Qloo tools to call and in what order (function calling over the harness's own MCP tool schemas, budget of 14 calls). Without it, a fixed booking workflow runs the same steps.

**Grounding check:** before anything reaches the poster, every city, act and place the agent names is checked against the names Qloo actually returned. Anything else is removed, and the poster says what was removed.

### Example (request → result)
`Prateek Kuhad`, musician, India →
`qloo_where_popular {entity: "Prateek Kuhad", entity_type: "artist", within: "India"}` → ranked localities with affinity scores → top 6 become tour stops →
`qloo_recommend {target_type: "place", signals: ["Prateek Kuhad"], filter_location: "<top city>"}` → places listed under that stop as crowd favourites.

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

## License
MIT. Built for the Qloo Agentic Hackathon (2026).
