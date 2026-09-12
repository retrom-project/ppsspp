import tempfile
import unittest
from pathlib import Path

from runtime_assets import stage_assets


class RuntimeAssetsTest(unittest.TestCase):
    def test_native_resources_exclude_debugger_and_git_files_after_rebuild(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / "source", root / "stage"
            for name, content in {
                "flash0/font/font.pgf": b"font",
                "shaders/default.vsh": b"shader",
                "debugger/index.html": b"desktop debugger",
                "debugger/.git": b"gitdir: hidden",
                "shaders/.gitignore": b"metadata",
            }.items():
                file = source / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(content)
            target.mkdir()
            (target / "stale-debugger.js").write_bytes(b"old build")
            stage_assets(source, target)
            self.assertEqual({str(file.relative_to(target)): file.read_bytes()
                              for file in target.rglob("*") if file.is_file()}, {
                "flash0/font/font.pgf": b"font", "shaders/default.vsh": b"shader",
            })
