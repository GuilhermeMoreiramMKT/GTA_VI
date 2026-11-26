#!/usr/bin/env python3
"""Discover public Kick clips with real engagement and a completed archive match."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import time
from urllib.parse import urlparse

GTA = re.compile(r"\b(?:gta|grand theft auto)\s*(?:vi|6)\b", re.I)
EDITORIAL = json.loads((Path(__file__).resolve().parents[1] / "config" / "editorial.json").read_text(encoding="utf-8"))
DEFAULT = ",".join(EDITORIAL["kick"])
HUMOR_SIGNAL = re.compile(r"\bk{3,}\b|\b(?:engraçad[oa]s?|risadas?|rach[eo]i|hilári[oa]s?|zoeira)\b|[😂🤣]", re.I)

class Quiet:
    def debug(self, message): pass
    def warning(self, message): pass
    def error(self, message): pass

def listing(slug, kind, limit):
    import yt_dlp
    url = f"https://kick.com/{slug}/{kind}" + ("?sort=view&range=week" if kind == "clips" else "")
    opts = {"extract_flat": True, "playlistend": limit, "skip_download": True,
            "quiet": True, "no_warnings": True, "logger": Quiet(),
            "socket_timeout": 15, "retries": 0, "extractor_retries": 0,
            "ignoreerrors": False, "cachedir": False}
    with yt_dlp.YoutubeDL(opts) as ydl:
        result = ydl.extract_info(url, download=False)
        if not result or result.get("_type") != "playlist":
            raise RuntimeError("Public playlist unavailable")
        return [entry for entry in result.get("entries", []) if entry]

def number(value):
    return value if isinstance(value, (float, int)) and math.isfinite(value) else 0

def game(entry):
    return bool(GTA.search(" ".join([str(entry.get("title",""))]+[str(x) for x in entry.get("categories") or []])))

def collect(slug):
    now = time.time()
    try:
        clips = listing(slug,"clips",30)
        archives = listing(slug,"videos",20)
    except Exception as exc:
        return [], {"channel":slug,"status":"unavailable","reason":type(exc).__name__}
    valid_archives = [a for a in archives if a.get("is_live") is False and a.get("availability")=="public"
                      and number(a.get("timestamp"))>0 and number(a.get("duration"))>=30
                      and number(a.get("timestamp"))+number(a.get("duration"))<now and game(a)]
    items = []
    rejected = {key:0 for key in ('metadata','duration','editorial','archive','category')}
    for index, clip in enumerate(sorted(clips,key=lambda x:-number(x.get("view_count")))):
        ident = str(clip.get("id",""))
        ts = number(clip.get("timestamp"))
        duration = number(clip.get("duration"))
        views = number(clip.get("view_count"))
        if not re.fullmatch(r"clip_[\w-]+",ident) or views<=0 or not now-7*86400<=ts<=now:
            rejected["metadata"] += 1
            continue
        if not 30<=duration<=90:
            rejected["duration"] += 1
            continue
        if re.search(r"strip club|private dance|nude|nsfw",str(clip.get("title","")),re.I):
            rejected["editorial"] += 1
            continue
        # A timestamp match is evidence of a finished VOD, not a platform-provided clip/VOD ID link.
        archive = next((a for a in valid_archives if number(a.get("timestamp"))<=ts<=number(a.get("timestamp"))+number(a.get("duration"))),None)
        if not archive:
            rejected["archive"] += 1
            continue
        if not game(clip):
            rejected["category"] += 1
            continue
        output_duration = min(duration,40) if duration>45 else duration
        score = 0
        items.append({"id":"kick-clip-"+ident,"title":str(clip.get("title") or "Momento de GTA VI"),
                      "url":f"https://kick.com/{slug}/clips/{ident}","channel":str(clip.get("channel") or slug),
                      "channelSlug":slug,"source":"Kick","language":"unknown","views":int(views),"score":score,
                      "humorSignals":int(bool(HUMOR_SIGNAL.search(str(clip.get("title",""))))),
                      "duration":output_duration,"sourceDuration":duration,"start":0,"publishedAt":datetime.fromtimestamp(ts,timezone.utc).isoformat(),
                      "evidence":f"Kick public clip views, relative rank among eligible GTA clips and recency; timestamp matched completed public GTA VI archive {archive.get('id','')}; score applies to source clip, excerpt starts at 0"})
    for rank, item in enumerate(items):
        age = now - datetime.fromisoformat(item["publishedAt"]).timestamp()
        item["score"] = round(min(50,10*math.log10(1+item["views"])) + 20*(1-rank/max(1,len(items))) + 15*max(0,1-age/(7*86400)) + 15)
    return items,{"channel":slug,"status":"ok","clips":len(clips),"archives":len(archives),"completedGtaArchives":len(valid_archives),"matches":len(items),"qualified":sum(x["score"]>=EDITORIAL["minScore"] for x in items),"rejected":rejected,"highestScore":max((x["score"] for x in items),default=0)}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--output",required=True)
    parser.add_argument("--channels",default=os.environ.get("RADAR_KICK_CHANNELS",DEFAULT))
    args=parser.parse_args()
    slugs=list(dict.fromkeys(s.strip().lower() for s in args.channels.split(",") if re.fullmatch(r"[a-zA-Z0-9_-]{1,40}",s.strip())))[:8]
    with ThreadPoolExecutor(max_workers=3) as pool:
        result=list(pool.map(collect,slugs))
    candidates=sorted([item for items,_ in result for item in items if item["score"]>=EDITORIAL["minScore"]],key=lambda x:-x["score"])
    reports=[report for _,report in result]
    payload={"candidates":candidates,"channels":reports,"provider":"ok" if any(x["status"]=="ok" for x in reports) else "unavailable"}
    Path(args.output).write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"provider":payload["provider"],"channels":reports,"qualified":len(candidates)}))

if __name__=="__main__":
    main()
