#!/usr/bin/env python3
"""Assemble upstream/component notices beside the downloadable browser core."""
import sys
from pathlib import Path
root = Path(__file__).resolve().parents[2]
paths = ["LICENSE.TXT", "ffmpeg/LICENSE.md", "ffmpeg/COPYING.LGPLv2.1",
    "ext/armips/LICENSE.txt", "ext/cityhash/COPYING", "ext/cpu_features/LICENSE",
    "ext/glslang/LICENSE.txt", "ext/SPIRV-Cross/LICENSE", "ext/miniupnp/LICENSE",
    "ext/nanosvg/LICENSE.txt", "ext/rcheevos/LICENSE", "ext/rapidjson/license.txt",
    "ext/snappy/COPYING", "ext/udis86/LICENSE", "ext/zlib/LICENSE", "ext/zstd/LICENSE",
    "ext/zstd/COPYING", "ext/libchdr/LICENSE.txt", "ext/libchdr/deps/lzma-24.05/LICENSE",
    "ext/OpenXR-SDK/LICENSE", "ext/freetype/LICENSE.TXT", "ext/armips/ext/filesystem/LICENSE", "ext/gason/LICENSE",
    ".retrom-build/web/libpng-LICENSE", ".retrom-build/web/emscripten-LICENSE"]
notices = ["PPSSPP Retrom browser core\nSource: https://github.com/retrom-project/ppsspp\n"
    "Upstream: https://github.com/hrydgard/ppsspp at 2e6fd06ed6c77db467dea5fb3f67abd93457da20\n"
    "Build: Emscripten 4.0.10; FFmpeg configured without GPL/nonfree components.\n"]
for path in paths:
    notices.append(f"\n===== {path} =====\n" + (root / path).read_text(encoding="utf-8"))
# Preserve in-source component notices without copying implementations.
for path in ["ext/libkirk/kirk_engine.c", "ext/libkirk/AES.c", "ext/libkirk/SHA1.c",
             "libretro/libretro-common/streams/file_stream.c"]:
    source = (root / path).read_text(encoding="utf-8")
    notices.append(f"\n===== {path} =====\n" + source[:source.index("*/") + 2])
lua = (root / "ext/lua/lua.h").read_text()
notices.append("\n===== Lua =====\n" + lua[lua.index("/******************************************************************************\n* Copyright"):lua.rindex("#endif")])
Path(sys.argv[1]).write_text("\n".join(notices), encoding="utf-8")
