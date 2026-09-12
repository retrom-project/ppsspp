"""Stage the native PSP resources separately from the desktop debugger website."""
import shutil
from pathlib import Path


def stage_assets(source, target):
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target, ignore=shutil.ignore_patterns("debugger", ".git*"))


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    stage_assets(root / "assets", root / ".retrom-build/web/assets")
