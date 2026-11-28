"""Independent handoffs for mining, transcription and replay matching."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import re
from urllib.parse import parse_qs, urlsplit


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def public_link(url):
    link = urlsplit(url)
    if link.scheme != "https" or link.username or link.password or link.port:
        return None
    host, path = link.hostname, link.path
    if host in {"youtube.com", "www.youtube.com", "youtu.be"}:
        video = parse_qs(link.query).get("v", [""])[0] if path == "/watch" else path.split("/")[-1]
        if re.fullmatch(r"[A-Za-z0-9_-]{11}", video):
            return "youtube", video, "https://www.youtube.com/watch?v=" + video
    if host in {"instagram.com", "www.instagram.com"}:
        match = re.fullmatch(r"/(?:reel|p)/([\w-]+)/?", path)
        if match:
            video = match[1]
            return "instagram", video, "https://www.instagram.com/" + path.strip("/") + "/"
    if host in {"tiktok.com", "www.tiktok.com"}:
        match = re.fullmatch(r"/(@[\w.-]+)/video/(\d+)/?", path)
        if match:
            return "tiktok", match[2], f"https://www.tiktok.com/{match[1]}/video/{match[2]}"
    return None


def mine(items, now, min_views=1000, min_per_hour=100):
    leads = {}
    for item in items:
        try:
            link = public_link(item["url"])
            age = now - datetime.fromisoformat(item["publishedAt"].replace("Z", "+00:00"))
            metrics = {key: item.get(key) for key in ("views", "likes", "shares")}
            if any(value is not None and (type(value) is not int or value < 0) for value in metrics.values()):
                continue
            views = metrics["views"]
            if not link or views is None or views < min_views or not timedelta(0) <= age <= timedelta(days=7):
                continue
        except (KeyError, ValueError, TypeError):
            continue
        platform, video, url = link
        velocity = (views + 4 * (metrics["likes"] or 0) + 8 * (metrics["shares"] or 0)) / max(2, age.total_seconds()/3600)
        if velocity < min_per_hour:
            continue
        record = {"platform": platform, "id": video, "url": url, "publishedAt": item["publishedAt"],
                  "channel": item.get("channel"), "title": item.get("title"), **metrics,
                  "weightedEngagementPerHour": round(velocity, 2)}
        key = (platform, video)
        if key not in leads or velocity > leads[key]["weightedEngagementPerHour"]:
            leads[key] = record
    return sorted(leads.values(), key=lambda item: -item["weightedEngagementPerHour"])


def transcribe(leads, media, out):
    import subprocess
    import numpy as np
    from faster_whisper import WhisperModel

    model = None
    receipts = []
    out.mkdir(parents=True, exist_ok=True)
    for lead in leads:
        key = lead["platform"] + "-" + lead["id"]
        paths = [p for p in media.glob(key + ".*") if p.suffix.lower() in {".mp4", ".m4a", ".mp3", ".wav", ".webm", ".opus", ".mov", ".ogg"}]
        if len(paths) != 1:
            receipts.append({"key": key, "status": "authorized_media_missing_or_ambiguous"})
            continue
        path = paths[0]
        try:
            probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries",
                "format=duration,format_name:stream=codec_type,codec_name,width,height", "-of", "json", str(path)], timeout=30))
            raw = subprocess.check_output(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
                "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], timeout=90)
            if not raw:
                raise ValueError("Empty audio")
            if model is None:
                model = WhisperModel("small", device="cpu", compute_type="int8")
            samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
            segments, info = model.transcribe(samples, vad_filter=True)
            rows = [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in segments]
            write(out / (key + ".json"), {"metadata": lead, "media": probe, "language": info.language, "transcript": rows})
            receipts.append({"key": key, "status": "transcribed" if rows else "no_speech"})
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            receipts.append({"key": key, "status": "transcription_failed", "reason": type(exc).__name__})
    return receipts


def locate(corpus, directory):
    from match_live_transcripts import match

    results = []
    for path in sorted(directory.glob("*.json")):
        record = read(path)
        lead = record["metadata"]
        result = match(corpus, record["transcript"])
        if result["status"] == "candidate_for_media_review":
            hit = result["match"]
            start = math.floor(hit["start"])
            duration = min(45, max(30, math.ceil(float(record["media"]["format"]["duration"]))))
            results.append({"reference": lead["url"], "status": "awaiting_editorial_review",
                            "day": hit["day"], "source": hit["url"], "start": start,
                            "end": start + duration, "agreement": hit["agreement"]})
        else:
            results.append({"reference": lead["url"], **result})
    return results


def render(results, out):
    from scan_coringa_archive import ARCHIVE
    from produce_candidate import produce

    for row in [entry for entry in results if entry["status"] == "awaiting_editorial_review"][:2]:
        original = ARCHIVE.get(row["day"])
        if not original:
            continue
        video, day, length = original
        url = "https://kick.com/coringa/videos/" + video
        start, end = row["start"], row["end"]
        if row["source"] != url or not 0 <= start < end <= length:
            continue
        candidate = {"id": f"kick-clip-coringa-vod-{video}-{start}", "source": "Kick",
                     "channel": "LOUD Coringa", "channelSlug": "coringa", "url": url,
                     "publishedAt": day + "T00:00:00Z", "language": "pt-BR",
                     "score": round(row["agreement"] * 100), "start": start, "duration": end - start,
                     "title": "Momento da live de LOUD Coringa", "discovery": "third-party-clip",
                     "referenceClip": {"url": row["reference"]}, "evidence": "Transcript alignment; media review required"}
        folder = out / f"corte-{start}"
        try:
            produce(candidate, folder)
        except Exception as exc:
            row["render"] = type(exc).__name__
        else:
            row["render"] = "ready_for_media_review"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=("mine", "transcribe", "locate", "render"))
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--media", type=Path)
    parser.add_argument("--corpus", type=Path)
    args = parser.parse_args()
    if args.stage == "mine":
        report = read(args.input)
        rows = report if isinstance(report, list) else report["metricSignals"]
        write(args.output, mine(rows, datetime.now(timezone.utc)))
    elif args.stage == "transcribe":
        if args.media is None:
            parser.error("transcribe requires --media")
        write(args.output, transcribe(read(args.input), args.media, args.output.parent / "transcripts"))
    elif args.stage == "render":
        results = read(args.input)
        render(results, args.output.parent)
        write(args.output, results)
    else:
        if args.corpus is None:
            parser.error("locate requires --corpus")
        write(args.output, locate(read(args.corpus), args.input))


if __name__ == "__main__":
    main()
