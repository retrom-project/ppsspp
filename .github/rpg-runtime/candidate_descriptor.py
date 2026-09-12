#!/usr/bin/env python3
"""Validate a candidate directory and emit the common Retrom core descriptor."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def git_bytes(*arguments: str) -> bytes:
    result = subprocess.run(["git", "-C", str(ROOT), *arguments], capture_output=True, check=False)
    if result.returncode != 0:
        raise SystemExit("PFB_WORKTREE_INVALID")
    return result.stdout


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def digest_file(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def checked_output(raw: str, *, empty: bool) -> Path:
    output = Path(raw)
    if not output.is_absolute() or output.is_symlink() or not output.is_dir():
        raise SystemExit("PFB_CANDIDATE_OUTPUT_INVALID")
    if empty and any(output.iterdir()):
        raise SystemExit("PFB_CANDIDATE_OUTPUT_INVALID")
    return output


def is_worktree_root(root: Path) -> bool:
    result = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
        capture_output=True, check=False, text=True,
    )
    return result.returncode == 0 and Path(result.stdout.strip()).resolve() == root.resolve()


def source_tree_sha256() -> str:
    raw_paths = git_bytes("ls-files", "--cached", "--others", "--exclude-standard", "-z")
    raw_modes = git_bytes("ls-files", "--stage", "-z")
    tracked = {}
    for item in raw_modes.split(b"\0"):
        if item:
            prefix, path = item.split(b"\t", 1)
            parts = prefix.split(b" ")
            tracked[path.decode("utf-8")] = (
                parts[0].decode("ascii"), parts[1].decode("ascii"),
            )
    records = []
    for raw in sorted(set(raw_paths.split(b"\0"))):
        if not raw:
            continue
        relative = raw.decode("utf-8")
        target = ROOT / relative
        try:
            info = target.lstat()
        except FileNotFoundError:
            continue
        tracked_mode, tracked_object = tracked.get(relative, (None, None))
        if tracked_mode == "160000" and stat.S_ISDIR(info.st_mode):
            mode = "160000"
            nested = {"indexCommit": tracked_object, "worktreeCommit": None, "sourceTreeSha256": None}
            if is_worktree_root(target):
                nested["worktreeCommit"] = subprocess.check_output(
                    ["git", "-C", str(target), "rev-parse", "HEAD"], text=True,
                ).strip()
                nested["sourceTreeSha256"] = nested_source_tree_sha256(target)
            file_digest = digest_bytes(
                json.dumps(nested, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
            )
        elif stat.S_ISLNK(info.st_mode):
            mode = "120000"
            file_digest = digest_bytes(os.readlink(target).encode("utf-8"))
        elif stat.S_ISREG(info.st_mode):
            mode = tracked_mode or ("100755" if info.st_mode & stat.S_IXUSR else "100644")
            file_digest = digest_file(target)
        else:
            raise SystemExit("PFB_WORKTREE_INVALID")
        records.append({"path": relative, "mode": mode, "sha256": file_digest})
    canonical = json.dumps(records, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return digest_bytes(canonical)


def nested_source_tree_sha256(root: Path) -> str:
    raw_paths = subprocess.check_output(
        ["git", "-C", str(root), "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    )
    raw_modes = subprocess.check_output(["git", "-C", str(root), "ls-files", "--stage", "-z"])
    tracked = {}
    for item in raw_modes.split(b"\0"):
        if item:
            prefix, path = item.split(b"\t", 1)
            parts = prefix.split(b" ")
            tracked[path.decode("utf-8")] = (parts[0].decode("ascii"), parts[1].decode("ascii"))
    records = []
    for raw in sorted(set(raw_paths.split(b"\0"))):
        if not raw:
            continue
        relative = raw.decode("utf-8")
        target = root / relative
        try:
            info = target.lstat()
        except FileNotFoundError:
            continue
        tracked_mode, tracked_object = tracked.get(relative, (None, None))
        if tracked_mode == "160000" and stat.S_ISDIR(info.st_mode):
            nested = {"indexCommit": tracked_object, "worktreeCommit": None, "sourceTreeSha256": None}
            if is_worktree_root(target):
                nested["worktreeCommit"] = subprocess.check_output(
                    ["git", "-C", str(target), "rev-parse", "HEAD"], text=True,
                ).strip()
                nested["sourceTreeSha256"] = nested_source_tree_sha256(target)
            mode = "160000"
            file_digest = digest_bytes(json.dumps(
                nested, ensure_ascii=False, separators=(",", ":"), sort_keys=True,
            ).encode("utf-8"))
        elif stat.S_ISLNK(info.st_mode):
            mode = "120000"
            file_digest = digest_bytes(os.readlink(target).encode("utf-8"))
        elif stat.S_ISREG(info.st_mode):
            mode = tracked_mode or ("100755" if info.st_mode & stat.S_IXUSR else "100644")
            file_digest = digest_file(target)
        else:
            raise SystemExit("PFB_WORKTREE_INVALID")
        records.append({"path": relative, "mode": mode, "sha256": file_digest})
    canonical = json.dumps(records, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return digest_bytes(canonical)


def finalize(output: Path, core_id: str) -> None:
    fork = json.loads((ROOT / "retrom-fork.json").read_text(encoding="utf-8"))
    expected = sorted(name for name in fork["releaseAssets"] if name != "rpg-runtime-release.json")
    actual = sorted(path.name for path in output.iterdir())
    if actual != expected:
        raise SystemExit("PFB_CANDIDATE_OUTPUT_INVALID")
    branch = git_bytes("rev-parse", "--abbrev-ref", "HEAD").decode("utf-8").strip()
    commit = git_bytes("rev-parse", "HEAD").decode("ascii").strip()
    dirty = bool(git_bytes("status", "--porcelain=v1", "-z"))
    files = [
        {"filename": name, "sizeBytes": (output / name).stat().st_size, "sha256": digest_file(output / name)}
        for name in expected
    ]
    descriptor = {
        "schemaVersion": 1,
        "kind": "RETROM_CORE_CANDIDATE_V1",
        "coreId": core_id,
        "repository": fork["forkRepository"],
        "branch": branch,
        "commit": commit,
        "dirty": dirty,
        "sourceTreeSha256": source_tree_sha256(),
        "adapterAbi": fork["adapterAbi"],
        "files": files,
    }
    (output / "retrom-core-candidate.json").write_text(
        json.dumps(descriptor, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("prepare", "finalize"))
    parser.add_argument("output")
    parser.add_argument("--core-id")
    args = parser.parse_args()
    output = checked_output(args.output, empty=args.action == "prepare")
    if args.action == "finalize":
        if not args.core_id:
            raise SystemExit("PFB_CANDIDATE_OUTPUT_INVALID")
        finalize(output, args.core_id)


if __name__ == "__main__":
    main()
