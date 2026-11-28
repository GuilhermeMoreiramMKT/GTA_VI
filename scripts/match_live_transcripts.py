"""Build a timecoded VOD corpus and match independently produced transcripts."""
import argparse
from collections import Counter, defaultdict
from difflib import SequenceMatcher
import json
from pathlib import Path
import re
import unicodedata
from zipfile import ZipFile


def words(text):
    return re.findall(r"[a-z0-9]+", unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower())


def build(zips):
    lives = {}
    for path in sorted(zips):
        with ZipFile(path) as archive:
            try:
                index = json.loads(archive.read("index.json"))
                rows = json.loads(archive.read("transcricao.json"))
            except KeyError:
                continue
        live = lives.setdefault(index["url"], {"day": index["day"], "url": index["url"], "blocks": []})
        live["blocks"].append({"start": index["offset"], "seconds": index["seconds"], "segments": rows})
    return {"lives": sorted(lives.values(), key=lambda live: live["day"])}


def match(corpus, rows):
    query = [(word, float(row["start"])) for row in rows for word in words(row.get("original") or row["text"])]
    if len(query) < 18:
        return {"status": "insufficient_speech", "words": len(query)}
    tokens, times = zip(*query)
    grams = {tokens[i:i+3] for i in range(len(tokens)-2)}
    proposals = []
    for live in corpus["lives"]:
        for block in live["blocks"]:
            stream = [(word, float(row["start"])) for row in block["segments"] for word in words(row["text"])]
            if len(stream) < 18:
                continue
            spoken, timestamps = zip(*stream)
            positions = defaultdict(list)
            for i in range(len(spoken)-2):
                gram = spoken[i:i+3]
                if gram in grams:
                    positions[gram].append(i)
            votes = Counter()
            for i in range(len(tokens)-2):
                hits = positions[tokens[i:i+3]]
                if len(hits) <= 35:
                    votes.update((j-i)//5 for j in hits)
            for bucket, count in votes.most_common(18):
                if count < 2:
                    continue
                begin = max(0, bucket*5-20)
                sample = spoken[begin:begin+len(tokens)+55]
                alignment = SequenceMatcher(None, tokens, sample, autojunk=False)
                blocks = [b for b in alignment.get_matching_blocks() if b.size >= 2]
                if not blocks:
                    continue
                first, last = blocks[0], blocks[-1]
                span = last.a + last.size - first.a
                score = sum(b.size for b in blocks) / len(tokens)
                start = max(0, timestamps[begin+first.b] - times[first.a])
                end = timestamps[begin+last.b+last.size-1]
                if span < len(tokens)*0.55 or end-start > times[-1]-times[0]+25:
                    continue
                proposals.append({"day": live["day"], "url": live["url"], "start": round(start, 1),
                                  "agreement": round(score, 3), "words": len(tokens)})
    ranked = []
    for item in sorted(proposals, key=lambda item: -item["agreement"]):
        if not any(other["url"] == item["url"] and abs(other["start"]-item["start"]) < 25 for other in ranked):
            ranked.append(item)
    if not ranked or ranked[0]["agreement"] < .56:
        return {"status": "unmatched", "suggestions": ranked[:3]}
    if len(ranked) > 1 and ranked[0]["agreement"]-ranked[1]["agreement"] < .10:
        return {"status": "ambiguous", "suggestions": ranked[:3]}
    return {"status": "candidate_for_media_review", "match": ranked[0]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--build", type=Path, nargs="+")
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--query", type=Path)
    args = parser.parse_args()
    if args.build:
        args.corpus.write_text(json.dumps(build(args.build), ensure_ascii=False), encoding="utf-8")
    if args.query:
        print(json.dumps(match(json.loads(args.corpus.read_text()), json.loads(args.query.read_text())), ensure_ascii=False))
