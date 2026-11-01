import subprocess
import tempfile
import unittest
from pathlib import Path


class MemoryArenaTest(unittest.TestCase):
    def test_no_mmap_reserves_the_complete_address_span(self):
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "arena"
            subprocess.run([
                "c++", "-std=c++17", "-DNO_MMAP", "-I", str(root),
                "-I", str(root / "Common"),
                str(root / ".github/rpg-runtime/memory_arena_test.cpp"),
                str(root / "Common/MemArenaPosix.cpp"), "-o", str(executable),
            ], check=True)
            subprocess.run([str(executable)], check=True)
