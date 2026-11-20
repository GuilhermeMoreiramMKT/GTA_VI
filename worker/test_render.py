import json
import pathlib
import shutil
import tempfile
import unittest
from unittest.mock import patch

import worker

@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg tools unavailable")
class RenderTest(unittest.TestCase):
    def test_vertical_mp4(self):
        with tempfile.TemporaryDirectory() as temp:
            work = pathlib.Path(temp)
            source = work / "source.mp4"
            worker.run("ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                       "color=c=navy:s=640x360:r=30:d=36", "-c:v", "libx264", source)
            audio = worker.run("ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                               "anullsrc=r=44100:cl=mono", "-t", "33", "-f", "mp3", "pipe:1")
            script = {"narration": "teste " * 75, "caption": "Teste sintético"}
            response = {"output": [{"content": [{"type": "output_text", "text": json.dumps(script)}]}]}
            job = {"title": "Teste", "source_url": "https://example.com"}
            asset = {"notes": "Teste", "start_seconds": 1, "end_seconds": 36}
            with patch.object(worker, "ai", side_effect=[response, audio]):
                out, _, _ = worker.render(job, asset, source, work)
            probe = json.loads(worker.run("ffprobe", "-v", "error", "-show_streams", "-of", "json", out))
            video, sound = probe["streams"]
            self.assertEqual((video["width"], video["height"], video["codec_name"]), (1080, 1920, "h264"))
            self.assertEqual(sound["codec_name"], "aac")
            self.assertAlmostEqual(worker.duration(out), 33, delta=0.2)
