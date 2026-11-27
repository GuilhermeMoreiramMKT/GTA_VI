#!/usr/bin/env python3
"""Find and prepare review candidates in an official Coringa Kick replay."""
import argparse
import json
import re
import subprocess
from pathlib import Path

from faster_whisper import WhisperModel
from produce_candidate import flagged_text, produce

ARCHIVE = {
    2: ("01a1f4b1-55e8-7f55-b5c0-d46938964856", "2026-11-20", 50294),
    3: ("01a1f9ad-4a70-7e92-97dc-b9b84e4cd1b6", "2026-11-21", 43596),
    4: ("01a1ff2a-7518-7aa4-8938-f05218dd4293", "2026-11-22", 42128),
    5: ("01a20478-b7f0-73ea-b281-f0b1f5b462e9", "2026-11-23", 36504),
}
CHUNK = 10800
SIGNALS = {
    "Humor": r"\b(?:risadas?|que isso|não é possível|tá maluco|eu não aguento|do nada|coitado|morri)\b",
    "Novidade": r"\b(?:novo recurso|nova mecânica|agora tem|primeira vez|sistema de|personaliza\w+|vice city|mapa)\b",
    "Descoberta": r"\b(?:encontrei|achei|descobri\w*|escondid\w+|segredo|eu não sabia|nunca vi|olha isso|dá pra)\b",
    "Impacto": r"\b(?:não acredito|explodiu|o que aconteceu|caraca|meu deus|que loucura|surreal)\b",
}


def rank(rows, offset, length):
    options = []
    for index, row in enumerate(rows):
        start = max(0, round(row["start"]) - 1)
        if start + 35 > length:
            continue
        window = []
        for part in rows[index:]:
            if part["start"] >= start + 35:
                break
            window.append(part["text"])
        spoken = " ".join(window)
        if len(spoken) < 80 or flagged_text(spoken):
            continue
        signals = {category: len(re.findall(pattern, spoken, re.I)) for category, pattern in SIGNALS.items()}
        category = max(signals, key=signals.get)
        strongest = signals[category]
        if not strongest:
            continue
        score = min(96, 49 + strongest * 8 + min(18, sum(signals.values()) * 3)
                    + min(5, spoken.count("!") + spoken.count("?")))
        options.append((score, start + offset, category, spoken))
    chosen = []
    for option in sorted(options, reverse=True):
        if all(abs(option[1] - item[1]) >= 50 for item in chosen):
            chosen.append(option)
    return chosen


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("day", type=int, choices=ARCHIVE)
    parser.add_argument("shard", type=int, choices=range(5))
    args = parser.parse_args()
    video, day, duration = ARCHIVE[args.day]
    start = args.shard * CHUNK
    length = min(duration - start, CHUNK + 45)
    if length < 35:
        return
    url = "https://kick.com/coringa/videos/" + video
    output = Path("corpus")
    output.mkdir(exist_ok=True)
    media = Path("archive-source.mp4")
    command = ["python3", "-m", "yt_dlp", "--ignore-config", "--no-playlist", "--no-progress",
               "--quiet", "--socket-timeout", "25", "--retries", "2", "-f", "worst",
               "--download-sections", f"*{start}-{start + length}", "--merge-output-format", "mp4",
               "-o", str(media), url]
    subprocess.run(command, check=True)
    audio = Path("archive-audio.opus")
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(media), "-vn", "-ac", "1",
                    "-c:a", "libopus", "-b:a", "24k", str(audio)], check=True)
    model = WhisperModel("base", device="cpu", compute_type="int8", cpu_threads=4)
    segments, _ = model.transcribe(str(audio), language="pt", beam_size=1, vad_filter=True)
    transcript = [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in segments]
    if not transcript:
        raise RuntimeError("No speech transcribed from archive segment")
    options = rank(transcript, start, length)
    if args.shard:
        options = [item for item in options if item[1] >= start + 20]
    options = [item for item in options if item[1] < start + CHUNK + 20]
    (output / "index.json").write_text(json.dumps({
        "day": args.day, "url": url, "offset": start, "seconds": length,
        "candidates": [{"score": s, "start": t, "duration": 35, "category": c, "excerpt": x}
                       for s, t, c, x in options],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    clean = [{"start": row["start"] + start, "end": row["end"] + start, "text": row["text"]}
             for row in transcript]
    (output / "transcricao.json").write_text(json.dumps(clean, ensure_ascii=False), encoding="utf-8")
    media.unlink()
    audio.unlink()
    for score, time, category, excerpt in options[:4]:
        candidate = {
            "id": f"kick-clip-coringa-vod-{video}-{time}",
            "source": "Kick", "channel": "LOUD Coringa", "channelSlug": "coringa",
            "url": url, "publishedAt": day + "T00:00:00Z",
            "language": "pt-BR", "score": score, "start": time, "duration": 35,
            "title": f"Coringa joga GTA VI — dia {args.day}",
            "evidence": category + " | " + excerpt,
        }
        clip = output / f"corte-{time}"
        try:
            produce(candidate, clip)
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(clip / "clip.mp4"),
                            "-vf", "fps=1,scale=160:-1,tile=6x6:margin=4:padding=3", "-frames:v",
                            "1", str(clip / "quadros.jpg")], check=True)
        except (ValueError, RuntimeError, subprocess.CalledProcessError) as error:
            print(f"Corte {time} aguardando revisão: {type(error).__name__}", flush=True)
    print(f"{length} segundos analisados; {len(options)} candidatos para revisão.")


if __name__ == "__main__":
    main()
