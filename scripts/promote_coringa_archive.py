#!/usr/bin/env python3
"""Admit only cuts whose exact artifact and timestamp passed editorial review."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request
import zipfile

from produce_candidate import flagged_text, write_ass

BASE = os.environ["RADAR_BASE_URL"].rstrip("/")
if BASE != "https://gta-viral-radar.vercel.app":
    raise ValueError("Unexpected production host")
REPO = "GuilhermeMoreiramMKT/GTA_VI"
RUN = os.environ["GITHUB_RUN_ID"]


def intake(action, body):
    request = urllib.request.Request(
        BASE + "/api/cron/production-intake?action=" + action,
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + os.environ["CRON_SECRET"], "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=40) as response:
        return json.load(response)


def get_artifact(artifact, archive):
    with archive.open("wb") as file:
        subprocess.run(["gh", "api", f"repos/{REPO}/actions/artifacts/{artifact}/zip"],
                       stdout=file, check=True)
    return zipfile.ZipFile(archive)


def cut_at(archive, item, work):
    timestamp = item["start"]
    if type(timestamp) is not int or timestamp < 0:
        raise ValueError("Invalid review timestamp")
    title = item["title"].strip()
    if not 8 <= len(title) <= 75 or flagged_text(title):
        raise ValueError("Invalid reviewed title")
    prefix = f"corte-{timestamp}/"
    with archive.open(prefix + "manifest.json") as file:
        manifest = json.load(file)
    if manifest["candidate"]["start"] != timestamp or manifest["candidate"]["channelSlug"] != "coringa":
        raise ValueError("Approved cut does not match artifact")
    source = work / "source.mp4"
    source.write_bytes(archive.read(prefix + "clip.mp4"))
    ass = work / "title.ass"
    write_ass(ass, [{"start": 0, "end": manifest["duration"], "text": "."}], title, manifest["duration"])
    ass.write_text("\n".join(line for line in ass.read_text(encoding="utf-8").splitlines()
                            if ",Subtitle,," not in line) + "\n", encoding="utf-8")
    output = work / "final.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-nostdin", "-i", str(source),
                    "-vf", "drawbox=x=0:y=0:w=iw:h=640:color=black:t=fill,ass=title.ass",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-c:a", "copy",
                    "-movflags", "+faststart", str(output)], check=True, cwd=work)
    manifest["candidate"]["title"] = title
    manifest["caption"] = title + " | LOUD Coringa #GTA6 #GTAVI #Coringa"
    manifest["archiveReview"] = True
    claim = intake("reserve", {"manifest": manifest, "run": RUN})
    if claim.get("existing") and claim.get("status") in {"rendered", "scheduling", "scheduled"}:
        return
    if claim.get("status") != "rendering" or not claim.get("uploadUrl"):
        raise RuntimeError("Archive reservation missing")
    # The production endpoint returns a short-lived signed upload URL. Keep it out of logs.
    upload = urllib.request.Request(claim["uploadUrl"], data=output.read_bytes(), method="PUT",
                                    headers={"Content-Type": "video/mp4"})
    with urllib.request.urlopen(upload, timeout=90):
        pass
    result = intake("finalize", {"id": claim["id"], "bytes": output.stat().st_size})
    if result.get("status") not in {"rendered", "scheduling", "scheduled"}:
        raise RuntimeError("Archive finalization missing")
    print(f"Approved archive cut {timestamp}: {result['status']}")


def main():
    items = json.loads(Path("config/coringa-archive-approved.json").read_text(encoding="utf-8"))
    batches = {}
    for item in items:
        artifact = str(item["artifact"])
        if not re.fullmatch(r"[0-9]+", artifact):
            raise ValueError("Invalid GitHub Actions artifact ID")
        batches.setdefault(artifact, []).append(item)
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for artifact, clips in batches.items():
            with get_artifact(artifact, work / "cuts.zip") as archive:
                for item in clips:
                    cut_at(archive, item, work)


if __name__ == "__main__":
    main()
