import unittest,tempfile,pathlib
from worker import rights,clip_start,mutation
class SafetyTests(unittest.TestCase):
 def test_no_rights(self):
  with tempfile.TemporaryDirectory() as t:
   with self.assertRaises(RuntimeError):rights(None,pathlib.Path(t),{})
 def test_clip_bounds(self):
  self.assertEqual(clip_start({"start_seconds":2,"end_seconds":45},50,35),2)
  with self.assertRaises(RuntimeError):clip_start({"start_seconds":10,"end_seconds":50},40,35)
 def test_escape(self):
  self.assertIn('schedulingType:automatic',mutation("ch",'texto "teste"',"https://example.org/a.mp4","instagram"))
if __name__=="__main__":unittest.main()
