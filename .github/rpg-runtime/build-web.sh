#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
mkdir -p .retrom-build/ffmpeg .retrom-build/web
if [[ ! -f .retrom-build/ffmpeg/install/lib/libavcodec.a ]]; then
  cd .retrom-build/ffmpeg
  emconfigure "$root/ffmpeg/configure" --prefix="$PWD/install" \
    --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
    --target-os=none --arch=wasm32 --enable-cross-compile --disable-asm \
    --disable-everything --disable-programs --disable-doc --disable-debug \
    --disable-network --disable-avdevice --disable-avfilter --disable-postproc \
    --disable-runtime-cpudetect --disable-stripping --enable-static --disable-shared \
    --extra-cflags='-pthread -O3' --extra-ldflags='-pthread' \
    --enable-decoder=h264,mpeg4,h263,h263p,mpeg2video,mjpeg,mjpegb,aac,aac_latm,atrac3,atrac3p,mp3,pcm_s16le,pcm_s8 \
    --enable-demuxer=h264,h263,m4v,mpegps,mpegvideo,avi,mp3,aac,pmp,oma,pcm_s16le,pcm_s8,wav \
    --enable-parser=h264,mpeg4video,mpegvideo,aac,aac_latm,mpegaudio --enable-protocol=file
  emmake make -j6 install
  cd "$root"
fi
emmake make -C libretro platform=emscripten \
  OBJECT_DIR=../.retrom-build/web/objects GIT_VERSION_SRC=../.retrom-build/web/git-version.cpp GIT_VERSION="${RETROM_CORE_VERSION:?}" \
  FFMPEGINCFLAGS="-I$root/.retrom-build/ffmpeg/install/include" -j6
cp libretro/ppsspp_libretro_emscripten.bc .retrom-build/web/ppsspp_libretro.a
em++ libretro/retrom/frontend.cpp .retrom-build/web/ppsspp_libretro.a \
  -I. -Ilibretro/libretro-common/include -std=c++17 -O3 -pthread -msimd128 \
  -Wl,--start-group .retrom-build/ffmpeg/install/lib/*.a -Wl,--end-group \
  -sUSE_ZLIB=1 -sUSE_LIBPNG=1 -sUSE_WEBGL2=1 -sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2 \
  -sFULL_ES3=1 -sOFFSCREENCANVAS_SUPPORT=1 -sPTHREAD_POOL_SIZE=16 -sPTHREAD_POOL_SIZE_STRICT=2 \
  -sINITIAL_MEMORY=268435456 -sMAXIMUM_MEMORY=2147483648 -sALLOW_MEMORY_GROWTH=1 \
  -sSTACK_SIZE=8388608 -sDEFAULT_PTHREAD_STACK_SIZE=2097152 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPPSSPP -sENVIRONMENT=worker \
  -lworkerfs.js -sEXPORTED_RUNTIME_METHODS='["FS","WORKERFS","PThread","ccall","HEAPU8","HEAP16"]' \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_psp_start","_psp_step","_psp_pause","_psp_stop","_psp_input","_psp_state_size","_psp_save","_psp_load"]' \
  --preload-file assets@/system/PPSSPP --no-entry -o .retrom-build/web/ppsspp.js

python3 - <<'PYNOTICE'
from pathlib import Path
paths = list(Path('/emsdk/upstream/emscripten/cache/ports/libpng').glob('*/LICENSE'))
assert len(paths) == 1, paths
Path('.retrom-build/web/libpng-LICENSE').write_bytes(paths[0].read_bytes())
Path('.retrom-build/web/emscripten-LICENSE').write_bytes(Path('/emsdk/upstream/emscripten/LICENSE').read_bytes())
PYNOTICE
