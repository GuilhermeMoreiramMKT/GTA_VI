#!/usr/bin/env python3
"""Produce a vertical Portuguese-subtitled clip from a scored candidate."""
import argparse
import json
import math
import os
from pathlib import Path
import re
import subprocess
import textwrap
import unicodedata
import urllib.request
from urllib.parse import urlparse
import zipfile

MODEL_URL = "https://argos-net.com/v1/translate-en_pb-1_9.argosmodel"


def run(*args):
    subprocess.run([str(value) for value in args], check=True)


def probe(path):
    return json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)
    ]))


EDITORIAL = json.loads((Path(__file__).resolve().parents[1] / "config" / "editorial.json").read_text(encoding="utf-8"))

def declared_creator(candidate):
    """Match the official source identities approved for automatic publication."""
    source = urlparse(candidate.get("url", ""))
    slug = str(candidate.get("channelSlug", "")).lower()
    platform = candidate.get("source")
    if source.scheme != "https" or source.username or source.password:
        return False
    if platform == "Kick":
        return source.hostname in {"kick.com", "www.kick.com"} and slug in EDITORIAL["kick"] and source.path.split("/")[1:2] == [slug]
    if platform == "Twitch":
        return source.hostname in {"twitch.tv", "www.twitch.tv", "clips.twitch.tv"} and slug in EDITORIAL["twitch"]
    if platform == "YouTube":
        return source.hostname in {"youtube.com", "www.youtube.com", "youtu.be"} and candidate.get("creatorId") in EDITORIAL["youtube"]
    return False


SEXUAL_CONTENT = re.compile(
    r"\b(?:sexo|sexuais?|sexual(?:mente)?|sexualizad[oa]s?|porn\w*|nude[sz]?|nudity|naked|"
    r"pelad[oa]s?|seminu[as]s?|strip(?:\s*club|tease|per)?|lap\s+dance|"
    r"prostitu\w*|brothel|escort|swingers?|bordel|puteiro|"
    r"cena(?:s)?\s+intima(?:s)?|suruba|orgi[ae]s?|transar|transando|"
    r"bagos|gyatt|hentai|onlyfans|blowjob|oral\s+sex|breasts?|penis|vagina|"
    r"genitais?|masturba\w*|seios?|testiculos?|orgasm\w*|gemid[oa]s?|"
    r"boate\s+de\s+strip|sexual\s+assault)\b",
    re.IGNORECASE,
)

def flagged_text(*parts):
    normalized = " ".join(str(part or "") for part in parts)
    normalized = unicodedata.normalize("NFKD", normalized)
    return bool(SEXUAL_CONTENT.search("".join(char for char in normalized if not unicodedata.combining(char))))


def choose(candidates, language):
    valid = [c for c in candidates if isinstance(c.get("score"), (float, int))
             and EDITORIAL["fallbackMinScore"] <= c["score"] <= 100 and 30 <= c["duration"] <= 45
             and (not language or c.get("language", "").lower().startswith(language))]
    if not valid:
        raise RuntimeError("No candidate meets the score, duration and language requirements")
    return sorted(valid, key=lambda c: (not declared_creator(c), -c["score"], -c.get("humorSignals", 0), -c.get("views", 0), c["id"]))[0]


def download(candidate, output):
    source = urlparse(candidate["url"])
    allowed = {"clips.twitch.tv", "www.twitch.tv", "twitch.tv", "www.youtube.com", "youtube.com", "youtu.be", "kick.com", "www.kick.com"}
    if source.scheme != "https" or source.hostname not in allowed or source.username or source.password:
        raise ValueError("Unexpected source URL")
    command = ["python3", "-m", "yt_dlp", "--ignore-config", "--no-playlist", "--no-cache-dir",
               "--no-progress", "--socket-timeout", "20", "--retries", "1",
               "-f", "bv*[height<=720]+ba/b[height<=720]/b", "--merge-output-format", "mp4"]
    if candidate["source"] == "YouTube":
        start = float(candidate["start"])
        if not math.isfinite(start) or start < 0:
            raise ValueError("Invalid start")
        command.extend(["--download-sections", f"*{start}-{start + candidate['duration']}", "--force-keyframes-at-cuts"])
    elif candidate["source"] == "Twitch" and source.hostname not in {"clips.twitch.tv", "www.twitch.tv", "twitch.tv"}:
        raise ValueError("Unexpected Twitch clip URL")
    run(*command, "-o", output, candidate["url"])


def natural_english(text):
    """Disambiguate common spoken/game idioms before machine translation without inventing meaning."""
    rules = (
        (r"\b(?:just\s+)?like\s+ingest\s+everything\s+about\b", "learn everything about"),
        (r"\bingest\s+everything\s+about\b", "learn everything about"),
        (r"\b(where\s+(?:they|you|we|I|he|she)\s+)work\s+out\b", r"\1exercise"),
        (r"\bscrolling\s+on\b", "browsing"),
        (r"\b(?:it(?:'|’)s|it is)\s+just\s+so\s+crazy\s+what\b", "It is amazing what"),
        (r"\bthat(?:'|’)s\s+called\b", "that is called"),
    )
    for pattern, replacement in rules:
        text = re.sub(pattern, replacement, text, flags=re.I)
    return text.strip()


class BrazilianTranslator:
    """OPUS-MT English→Brazilian Portuguese, Helsinki-NLP (CC BY 4.0), int8 conversion."""
    def __init__(self, folder):
        import ctranslate2
        import sentencepiece
        from huggingface_hub import snapshot_download

        root = Path(snapshot_download(
            "gow-solucoes/opus-mt-en-pt-ct2",
            revision="884d230",
            allow_patterns=["config.json", "model.bin", "shared_vocabulary.json", "source.spm", "target.spm"]
        ))
        self.source = sentencepiece.SentencePieceProcessor(model_file=str(root / "source.spm"))
        self.target = sentencepiece.SentencePieceProcessor(model_file=str(root / "target.spm"))
        self.model = ctranslate2.Translator(str(root), device="cpu", compute_type="int8", intra_threads=2)

    def translate(self, texts):
        if not texts:
            return []
        inputs = [[">>pob<<"] + self.source.encode(natural_english(text) or text, out_type=str) + ["</s>"] for text in texts]
        results = self.model.translate_batch(inputs, beam_size=4)
        return [self.target.decode(result.hypotheses[0]) for result in results]


def sentence_rows(segments, duration):
    """Translate coherent utterances across ASR segment boundaries, not arbitrary fragments."""
    rows, group = [], []
    def flush():
        if group:
            text = "".join(word.word for word in group).strip()
            rows.append({"start": max(0, group[0].start), "end": min(duration, group[-1].end), "text": text})
            group.clear()
    for segment in segments:
        words = [w for w in (segment.words or []) if w.start is not None and w.end is not None and w.word.strip()]
        if not words:
            flush()
            if segment.text.strip():
                rows.append({"start": max(0, segment.start), "end": min(duration, segment.end), "text": segment.text.strip()})
            continue
        for word in words:
            if group:
                pause = word.start - group[-1].end
                span = word.end - group[0].start
                punctuation = re.search(r"[.!?;]$", group[-1].word.strip())
                # Prefer pauses and punctuation; hard bounds prevent very long subtitles.
                if pause > 0.85 or (punctuation and len(group) >= 4) or (span > 12 and len(group) >= 22):
                    flush()
            group.append(word)
    flush()
    return rows


def transcribe(source, duration, working):
    from faster_whisper import WhisperModel

    audio = working / "audio.wav"
    run("ffmpeg", "-v", "error", "-nostdin", "-i", source, "-t", duration,
        "-vn", "-ac", "1", "-ar", "16000", audio)
    import wave
    import numpy as np
    with wave.open(str(audio), "rb") as wav:
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    whisper = WhisperModel("small", device="cpu", compute_type="int8", cpu_threads=2)
    segments, info = whisper.transcribe(samples, beam_size=5, vad_filter=True, word_timestamps=True)
    segments = list(segments)
    if not segments or info.language_probability < 0.45:
        raise RuntimeError("Speech could not be reliably identified")
    if info.language not in {"en", "pt"}:
        segments, _ = whisper.transcribe(samples, language=info.language, task="translate", beam_size=5, vad_filter=True, word_timestamps=True)
        segments = list(segments)
    rows = sentence_rows(segments, duration)
    rows = [row for row in rows if row["end"] > row["start"] and row["text"]]
    if not rows:
        raise RuntimeError("No usable speech segments")
    for row in rows:
        row["original"] = row["text"]
    translator = BrazilianTranslator(working / "translation") if info.language != "pt" else None
    if translator:
        translations = translator.translate([row["text"] for row in rows])
        for row, translated in zip(rows, translations):
            if not translated.strip():
                raise RuntimeError("Translation returned an empty line")
            row["text"] = translated
    return rows, info.language, translator


def ass_time(seconds):
    centis = max(0, int(round(seconds * 100)))
    return f"{centis // 360000}:{centis // 6000 % 60:02}:{centis // 100 % 60:02}.{centis % 100:02}"


def clean(text):
    return re.sub(r"\s+", " ", str(text)).strip().replace("\\", "/").replace("{", "(").replace("}", ")")


def write_ass(path, rows, hook, duration):
    style = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Title,DejaVu Sans,68,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,8,90,90,260,1
Style: Subtitle,DejaVu Sans,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,2,100,135,350,1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
"""
    lines = textwrap.wrap(clean(hook).upper(), width=22, break_long_words=False)
    if len(lines) > 3:
        lines = lines[:3]
        lines[-1] = lines[-1].rstrip(".") + "..."
    if len(lines) >= 2:
        lines[-1] = r"{\c&H0000E0FF&}" + lines[-1]
    events = [f"Dialogue: 0,0:00:00.00,{ass_time(duration)},Title,,0,0,0,," + r"\N".join(lines)]
    for row in rows:
        text = clean(row["text"])
        fragments = textwrap.wrap(text, width=30, break_long_words=False)
        if not fragments:
            continue
        # Split long sentences into short blocks of at most two lines.
        blocks = [fragments[i:i+2] for i in range(0, len(fragments), 2)]
        span = row["end"] - row["start"]
        weights = [max(1, sum(len(line) for line in block)) for block in blocks]
        total = sum(weights)
        elapsed = 0
        for index, block in enumerate(blocks):
            start = row["start"] + span * elapsed / total
            elapsed += weights[index]
            end = row["start"] + span * elapsed / total
            if end > start:
                events.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Subtitle,,0,0,0,," + r"\N".join(block))
    if len(events) < 2:
        raise RuntimeError("No subtitle events")
    path.write_text(style + "\n".join(events) + "\n", encoding="utf-8")


def produce(candidate, output):
    if flagged_text(candidate.get("title")):
        raise ValueError("Editorial content rejected by title")
    output.mkdir(parents=True, exist_ok=True)
    working = output / "working"
    working.mkdir(exist_ok=True)
    source = working / "source.mp4"
    download(candidate, source)
    length = min(float(candidate["duration"]), float(probe(source)["format"]["duration"]))
    if length < 30 or length > 45:
        raise RuntimeError("Downloaded interval has an invalid duration")
    rows, language, translator = transcribe(source, length, working)
    if flagged_text(*(row.get(field) for row in rows for field in ("original", "text"))):
        raise ValueError("Editorial content rejected by transcript")
    title = clean(candidate["title"])[:100]
    if title == title.upper():
        title = title.lower().capitalize()
    if translator and candidate.get("language", "").startswith("en") and len(title) >= 8:
        title = translator.translate([title])[0]
    elif language != "pt" or len(title) < 8:
        title = "MOMENTO DE GTA VI COM " + clean(candidate["channel"])
    ass = output / "legendagem-pt-br.ass"
    write_ass(ass, rows, title, length)
    final = output / "clip.mp4"
    old_dir = Path.cwd()
    try:
        os.chdir(output)
        run("ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i", source, "-t", length,
            "-map", "0:v:0", "-map", "0:a:0",
            "-vf", "scale=1080:608:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,ass=legendagem-pt-br.ass",
            "-c:v", "libx264", "-preset", "fast", "-crf", "21", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", final)
    finally:
        os.chdir(old_dir)
    result = probe(final)
    video = next(s for s in result["streams"] if s["codec_type"] == "video")
    if (video["width"], video["height"]) != (1080, 1920) or not any(s["codec_type"] == "audio" for s in result["streams"]):
        raise RuntimeError("Invalid rendered media")
    manifest = {"candidate": candidate, "detected_language": language, "subtitle_language": "pt-BR",
                "subtitle_segments": len(rows), "transcription_model": "faster-whisper-small", "subtitle_method": "contextual-sentences-idiom-aware-v3", "duration": float(result["format"]["duration"]),
                "caption": title + " | " + clean(candidate["channel"]) + " #GTAVI #GTA6 #GTAViralRadar",
                "status": "rendered_validation", "public_post": False}
    (output / "transcricao.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"score": candidate["score"], "language": language, "subtitle_segments": len(rows),
                      "duration": manifest["duration"], "status": manifest["status"]}))


def main():
    import shutil
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidates", required=True)
    parser.add_argument("--output", default="output")
    parser.add_argument("--language", default="")
    args = parser.parse_args()
    payload = json.loads(Path(args.candidates).read_text(encoding="utf-8"))
    pool = list(payload["candidates"])
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    for attempt in range(min(4, len(pool))):
        candidate = choose(pool, args.language)
        pool = [item for item in pool if item["id"] != candidate["id"]]
        staging = output / ("attempt-" + str(attempt))
        try:
            produce(candidate, staging)
        except (RuntimeError, ValueError, OSError, subprocess.CalledProcessError) as error:
            print("Candidate processing failed:", type(error).__name__, flush=True)
            continue
        for name in ("clip.mp4", "legendagem-pt-br.ass", "manifest.json", "transcricao.json"):
            shutil.copyfile(staging / name, output / name)
        return
    raise RuntimeError("No candidate could be rendered and verified")


if __name__ == "__main__":
    main()
