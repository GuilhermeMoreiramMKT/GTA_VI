#!/usr/bin/env python3
"""Download only a requested video interval and render a 9:16 MP4."""
import argparse
import ipaddress
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
from urllib.parse import urlparse

def run(args):
    print("+", " ".join(args[:2]), flush=True)
    subprocess.run(args, check=True)

def validate_url(value, youtube=False):
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("An HTTPS URL without embedded credentials is required")
    host = parsed.hostname.lower()
    if youtube:
        if host not in ("youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"):
            raise ValueError("YouTube input requires a YouTube URL")
    else:
        if host in ("localhost",) or host.endswith((".local", ".internal")):
            raise ValueError("Private hosts are not supported")
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            raise ValueError("Direct media URL must resolve to public IP addresses")
    return value

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--source", choices=["youtube", "direct"], required=True)
    p.add_argument("--url", required=True)
    p.add_argument("--start", type=int, required=True)
    p.add_argument("--duration", type=int, required=True)
    p.add_argument("--output", default="output/vertical-clip.mp4")
    a = p.parse_args()
    if not 0 <= a.start <= 86400 or not 30 <= a.duration <= 45:
        p.error("Start must be 0-86400; duration must be 30-45 seconds")
    validate_url(a.url, youtube=a.source == "youtube")
    output = Path(a.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path("output/source-part.mp4")
    if a.source == "youtube":
        end = a.start + a.duration + 2
        run([
            "yt-dlp", "--no-playlist", "--no-progress", "--no-cache-dir",
            "--js-runtimes", "node", "--remote-components", "ejs:github",
            "--socket-timeout", "20", "--retries", "2",
            "--download-sections", f"*{a.start}-{end}",
            "--force-keyframes-at-cuts", "-f",
            "bv*[height<=720]+ba/b[height<=720]/b",
            "--merge-output-format", "mp4", "-o", str(tmp), a.url,
        ])
        if not tmp.exists():
            candidates = list(output.parent.glob("source-part.*"))
            if not candidates:
                raise RuntimeError("No source interval was downloaded")
            tmp = candidates[0]
        input_file = str(tmp)
        seek_args = []
    else:
        # FFmpeg seeks before reading the remote source; suitable for seekable MP4.
        # Non-seekable sources may still require downloading more bytes.
        input_file = a.url
        seek_args = ["-ss", str(a.start)]
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin", "-y",
        *seek_args, "-i", input_file, "-t", str(a.duration),
        "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(output),
    ])
    if not output.is_file() or output.stat().st_size < 1000:
        raise RuntimeError("No valid output video was produced")
    run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1", str(output)])
    print("CLIP_READY:", output)

if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        print("CLIP_FAILED:", exc, file=sys.stderr)
        sys.exit(1)
