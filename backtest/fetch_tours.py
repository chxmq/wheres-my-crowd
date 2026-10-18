# Collect real concert tours with a US leg from Wikipedia (no key needed): tour page -> artist + list of US cities played.
#   python3 fetch_tours.py            crawl (polite, cached in cache/), write tours.json
#   python3 fetch_tours.py PAGE.html  parse one saved article page and print the result
import json, os, re, sys, time, urllib.request, urllib.parse, urllib.error, html, hashlib
from html.parser import HTMLParser
API = "https://en.wikipedia.org/w/api.php"
UA = {"User-Agent": "WheresMyCrowd-backtest/0.1 (hackathon research; github.com/chxmq/wheres-my-crowd)"}
_last = [0.0]
def api(**p):
    # Polite: one request at a time, at least 1.5 s apart, maxlag honoured, long back-off on 429.
    p.update(format="json", formatversion=2, maxlag=5)
    for k in range(6):
        wait = _last[0] + 1.5 - time.time()
        if wait > 0: time.sleep(wait)
        _last[0] = time.time()
        try: return json.load(urllib.request.urlopen(urllib.request.Request(API + "?" + urllib.parse.urlencode(p), headers=UA), timeout=30))
        except urllib.error.HTTPError as e:
            if e.code == 429: print("429, backing off", file=sys.stderr); time.sleep(int(e.headers.get("Retry-After") or 120))
            else: time.sleep(10)
        except Exception: time.sleep(10)
    return {}
def members(cat):
    out, cont = [], {}
    while True:
        r = api(action="query", list="categorymembers", cmtitle=cat, cmlimit=500, cmtype="page", **cont)
        out += [m["title"] for m in r.get("query", {}).get("categorymembers", [])]
        if "continue" not in r: return out
        cont = {"cmcontinue": r["continue"]["cmcontinue"]}
def page(t):
    # The article page itself (served from Wikipedia's cache; the parse API is rate-limited for anonymous clients).
    # One request every 3 s, cached on disk, so a re-run costs nothing.
    f = f"cache/{hashlib.sha1(t.encode()).hexdigest()[:16]}.html"
    if os.path.exists(f): return open(f).read()
    url = "https://en.wikipedia.org/wiki/" + urllib.parse.quote(t.replace(" ", "_"), safe="")
    for k in range(4):
        wait = _last[0] + 3 - time.time()
        if wait > 0: time.sleep(wait)
        _last[0] = time.time()
        try:
            h = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode("utf-8", "replace")
            open(f, "w").write(h); return h
        except urllib.error.HTTPError as e:
            if e.code == 429: print("429, backing off", file=sys.stderr); time.sleep(int(e.headers.get("Retry-After") or 120))
            elif e.code == 404: return ""
            else: time.sleep(10)
        except Exception: time.sleep(10)
    return ""

class Tables(HTMLParser):
    """Every wikitable as a grid of cell texts, with rowspan/colspan expanded. Footnote markers dropped."""
    def __init__(self):
        super().__init__(convert_charrefs=True); self.tables, self.stack, self.skip = [], [], 0
    def handle_starttag(self, tag, a):
        a = dict(a)
        if tag in ("sup", "style") : self.skip += 1; return
        if tag == "table": self.stack.append({"wiki": "wikitable" in (a.get("class") or ""), "rows": [], "row": None, "cell": None})
        if not self.stack: return
        t = self.stack[-1]
        if tag == "tr": t["row"] = []; t["rows"].append(t["row"])
        elif tag in ("td", "th") and t["row"] is not None:
            t["cell"] = {"h": tag == "th", "text": "", "link": None, "rs": int(re.sub(r"\D", "", a.get("rowspan") or "1") or 1), "cs": int(re.sub(r"\D", "", a.get("colspan") or "1") or 1)}
            t["row"].append(t["cell"])
        elif tag == "br" and t["cell"] is not None: t["cell"]["text"] += " "
        elif tag == "a" and t["cell"] is not None and t["cell"]["link"] is None and not self.skip: t["cell"]["link"] = a.get("title")
    def handle_endtag(self, tag):
        if tag in ("sup", "style"): self.skip = max(0, self.skip - 1); return
        if tag == "table" and self.stack:
            t = self.stack.pop()
            if t["wiki"]: self.tables.append(t["rows"])
        elif tag in ("td", "th") and self.stack: self.stack[-1]["cell"] = None
    def handle_data(self, d):
        if self.skip or not self.stack or self.stack[-1]["cell"] is None: return
        self.stack[-1]["cell"]["text"] += d
def grid(rows):
    out, carry = [], {}   # carry: col -> [remaining rows, text]
    for row in rows:
        line, col, cells = [], 0, list(row)
        while cells or any(c >= col for c in carry):
            if col in carry:
                n, txt = carry[col]; line.append(txt)
                if n <= 1: del carry[col]
                else: carry[col] = [n - 1, txt]
                col += 1; continue
            if not cells: break
            c = cells.pop(0); txt = (re.sub(r"\s+", " ", c["text"]).strip(), c["link"])
            for k in range(c["cs"]):
                line.append(txt)
                if c["rs"] > 1: carry[col] = [c["rs"] - 1, txt]
                col += 1
        out.append(line)
    return out

US = {"united states", "u.s.", "us", "usa", "united states of america"}
def parse(t, h):
    m = re.search(r'class="infobox-header"[^>]*>(.*?) concert chronology', h, re.S) or re.search(r'class="infobox-header"[^>]*>(.*?) (?:tour|concert) chronology', h, re.S)
    artist = html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip() if m else None
    if not artist: return None
    p = Tables(); p.feed(h)
    cities = []
    for rows in p.tables:
        g = grid(rows)
        if not g: continue
        head = [c[0].lower() for c in g[0]]
        ci = next((i for i, c in enumerate(head) if c.startswith("city")), None)
        co = next((i for i, c in enumerate(head) if c.startswith("country")), None)
        if ci is None or co is None: continue
        if "cancel" in " ".join(head) or any("reason" in c for c in head): continue   # cancelled-shows tables
        for r in g[1:]:
            if len(r) <= max(ci, co) or len(set(r)) == 1: continue   # leg-title rows span the whole table
            if r[co][0].lower().strip() in US and r[ci][0]: cities.append(r[ci][1] or r[ci][0])   # "Arlington, Texas" when linked
    us = sorted(set(c for c in cities if 2 < len(c) < 60))
    return {"tour": t, "artist": artist, "us_cities": us}

if __name__ == "__main__" and len(sys.argv) > 1:
    print(json.dumps(parse(sys.argv[1], open(sys.argv[1]).read()), indent=1)); sys.exit()
os.makedirs("cache", exist_ok=True)
tours = []
cats = [f"Category:{y} concert tours" for y in (2022, 2023, 2024, 2025)]
titles = json.load(open("titles.json")) if os.path.exists("titles.json") else list(dict.fromkeys(t for c in cats for t in members(c)))
json.dump(titles, open("titles.json", "w"))
LIMIT = int(os.environ.get("LIMIT") or len(titles))
print(len(titles), "tour pages; reading", LIMIT, file=sys.stderr)
log = open("fetch.log", "w", buffering=1)
for i, t in enumerate(titles[:LIMIT]):
    h = page(t)
    r = parse(t, h) if h else None
    if r and len(r["us_cities"]) >= 8:
        tours.append(r); log.write(f"{len(tours):3d} {r['artist'][:30]:30s} {len(r['us_cities']):3d}\n")
    if i % 25 == 0:
        log.write(f"-- {i}/{LIMIT} pages, {len(tours)} kept\n"); json.dump(tours, open("tours.partial.json", "w"))
json.dump(tours, open("tours.json", "w"), indent=1)
print("kept", len(tours), "tours with 8+ US cities", file=sys.stderr)
