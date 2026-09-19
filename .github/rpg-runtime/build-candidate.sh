#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
output=${1:?absolute empty output directory required}
python3 "$root/.github/rpg-runtime/candidate_descriptor.py" prepare "$output"
node --experimental-vm-modules --test "$root"/libretro/retrom/tests/*.test.mjs
docker run --rm --user "$(id -u):$(id -g)" --env HOME=/tmp \
  --env RETROM_CORE_VERSION="$(git -C "$root" describe --always --dirty)" \
  --volume "$root:/source" --workdir /source \
  emscripten/emsdk@sha256:90b757eb11fa9a0e3ce4d2d9f76d932a56018e4accc37b5a28b2783751e60eb7 \
  bash /source/.github/rpg-runtime/build-web.sh
cp "$root"/.retrom-build/web/ppsspp.{js,wasm,data} "$output/"
cp "$root"/.retrom-build/web/ppsspp-host.mjs "$root"/.retrom-build/web/ppsspp.worker.mjs "$output/"
python3 "$root/.github/rpg-runtime/licenses.py" "$output/LICENSE"
python3 "$root/.github/rpg-runtime/candidate_descriptor.py" finalize "$output" --core-id ppsspp
