# Retrom PPSSPP browser core

The official upstream baseline is `hrydgard/ppsspp@2e6fd06ed6c77db467dea5fb3f67abd93457da20`.
`master` mirrors upstream. `retrom/g2e6fd06ed6c7` owns Retrom integration. `retrom-fork.json`
is the machine-readable source of branch, ABI and release identities.

## Architecture

The portable PPSSPP CPU uses its IR JIT with WebAssembly SIMD. The GLES3 renderer runs on
WebGL2 in a dedicated worker with OffscreenCanvas. Native helper threads use Emscripten pthreads.
The small frontend implements libretro environment, input, audio and lifecycle callbacks; no
EmulatorJS or RetroArch frontend is loaded. WebGL2, cross-origin isolation, SharedArrayBuffer,
OffscreenCanvas and worker modules are required. PSP networking is disabled in this integration.

The host ABI is `ppsspp-host-v3`, with `content-io-v1` and the exact runtime contract hash.
The host accepts disc SHA-256/size metadata and a role-limited consumer port/SAB, never a game URL.
The emulation worker imports the runtime-provided verified `sync-client.mjs` Blob URL, validates
ABI/hash and acknowledges client readiness before native startup can succeed. The Provider owns
all HTTP, caching, persistence and cancellation. No separate PPSSPP I/O worker is built or released.

The read-only virtual disc preserves `/game/content.<format>`, native seek/read and EOF semantics.
Its facade splits native reads into <=256 KiB portions sharing one 15-second logical deadline;
only the public sync client caches blocks. Native stop runs while content remains available, then
the reader closes. Forced Provider shutdown revokes the shared slot and wakes blocked readers.
Contract/schema/error-number files in `libretro/retrom/content-io-v1` are immutable mirrors for
ABI checking, not a second implementation of transport or storage.

`ppsspp-state-v1` contains a little-endian uint32 JSON-header length, the UTF-8 header, complete
native state, then memory-stick files in header order. The header declares version, stateSize and
relative file paths/sizes. Paths, truncation, total size (256 MiB) and header size (1 MiB) are checked.
Memory-stick files are restored before boot; native state is restored only after the boot transition
finishes on the emulation frontend. Public gzip is applied exactly once by retrom-runtime.
EmulatorJS state formats are not declared compatible. Future upstream updates require a real
cross-version state test before retaining this format as readable.

## Build and test

Install Docker, Node.js and Python 3 as the current user. Initialize pinned Git submodules recursively.
The build script pins Emscripten 4.0.10 by image digest. It builds the pinned FFmpeg submodule with
selected PSP codecs and no network/GPL/nonfree components. All object files, FFmpeg output and
browser artifacts stay below ignored `.retrom-build/`. The pinned npm lock installs esbuild 0.27.0
there to bundle the host, emulation worker into two ESM entry points; internal
source modules are not additional release assets. The resulting manifest remains within the
Provider's existing bounded asset contract.
Native resources are staged separately before preloading. The unused desktop debugger website
and Git metadata are excluded, so recursively initialized submodules cannot enlarge the browser
resource package or embed repository pointer files. Staging is rebuilt from scratch each time.

```sh
python3 -B -m unittest discover -s .github/rpg-runtime -p 'test_*.py'
node --experimental-vm-modules --test libretro/retrom/tests/*.test.mjs
mkdir /absolute/empty/candidate
bash .github/rpg-runtime/build-candidate.sh /absolute/empty/candidate
```

For integration use Retrom `pfb-core-build PFB=psp CORE=ppsspp`. The descriptor records source
commit, dirty state, recursive source-tree hash, ABI and each output hash. Candidates may contain
uncommitted work; release.py rejects dirty source. Run the upstream native unit and tests_good
software-renderer suites as documented in `docs/building.md`. Run the Retrom `ACC-PSP-001`
product case with legally supplied fixtures: import, review preview, product launch, standard gamepad
direction/confirm, audio, pause, instant checkpoint, different-launch restore, continued input,
persistent content reuse and exit. Keep ROMs and generated evidence out of source control.

## Maintenance and release

Prefer small Emscripten-gated upstream patches and keep browser frontend changes in `libretro/retrom/`.
Sync the mirror by fast-forward; update a new maintenance baseline explicitly after evaluating upstream
changes and browser regressions. Do not rebase a published maintenance history or move published tags.

After product acceptance and authorization, merge the reviewed change to the maintenance branch and
create an annotated `retrom-core-g2e6fd06ed6c7-rN` tag (`-rc.N` for a prerelease). The release workflow
checks annotated-tag identity, baseline ancestry and maintenance inclusion, rebuilds the core,
validates clean source and uploads all assets plus licenses and `rpg-runtime-release.json`.
Replace retrom-runtime's development input with that immutable release identity, publish its next
Provider version, then update Retrom's production provider lock and rerun the same product case.
