#!/usr/bin/env python3
"""Turn a verified clean core build into immutable release assets."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def release(candidate, output, tag, commit):
    config = json.loads((ROOT / "retrom-fork.json").read_text())
    if not re.fullmatch(config["releaseTagPattern"], tag):
        raise ValueError("PPSSPP_RELEASE_TAG_INVALID")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("PPSSPP_RELEASE_COMMIT_INVALID")
    descriptor = json.loads((candidate / "retrom-core-candidate.json").read_text())
    if (descriptor.get("dirty") is not False or descriptor.get("commit") != commit
            or descriptor.get("repository") != config["forkRepository"]
            or descriptor.get("adapterAbi") != config["adapterAbi"]):
        raise ValueError("PPSSPP_RELEASE_SOURCE_INVALID")
    expected = set(config["releaseAssets"]) - {"rpg-runtime-release.json"}
    records = descriptor["files"]
    if len(records) != len(expected) or {r["filename"] for r in records} != expected:
        raise ValueError("PPSSPP_RELEASE_FILES_INVALID")
    if {p.name for p in candidate.iterdir()} != expected | {"retrom-core-candidate.json"}:
        raise ValueError("PPSSPP_RELEASE_FILES_INVALID")
    for record in records:
        path = candidate / record["filename"]
        if path.is_symlink() or not path.is_file():
            raise ValueError("PPSSPP_RELEASE_FILES_INVALID")
        data = path.read_bytes()
        if not data or len(data) != record["sizeBytes"] or hashlib.sha256(data).hexdigest() != record["sha256"]:
            raise ValueError("PPSSPP_RELEASE_INTEGRITY_INVALID")
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError("PPSSPP_RELEASE_OUTPUT_NOT_EMPTY")
    for name in sorted(expected):
        shutil.copyfile(candidate / name, output / name)
    metadata = {"schemaVersion": 1, "repository": config["forkRepository"], "tag": tag,
                "commit": commit, "adapterAbi": config["adapterAbi"], "files": records}
    (output / "rpg-runtime-release.json").write_text(json.dumps(metadata, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tag", required=True)
    args = parser.parse_args()
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT):
        raise ValueError("PPSSPP_RELEASE_SOURCE_DIRTY")
    release(args.candidate, args.output, args.tag, commit)
