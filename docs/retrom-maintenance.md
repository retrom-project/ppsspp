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
MediaEngine video decoding uses two FFmpeg codec threads in browser builds. Automatic CPU-based
thread counts can exhaust the fixed pthread pool shared with emulation, IO and utility workers,
causing H.264 initialization to fail before producing a frame.

The host ABI is `ppsspp-host-v4`, with `content-io-v1` and the exact runtime contract hash.
The host accepts disc SHA-256/size metadata and a role-limited consumer port/SAB, never a game URL.
The emulation worker imports the runtime-provided verified `sync-client.mjs` Blob URL, validates
ABI/hash and acknowledges client readiness before native startup can succeed. The Provider owns
all HTTP, caching, persistence and cancellation. No separate PPSSPP I/O worker is built or released.

Core startup requires an `assets` map containing Provider-verified Blob URLs for `ppsspp.js`,
`ppsspp.wasm`, `ppsspp.data` and `ppsspp.worker.mjs`. The host starts only that worker;
the worker imports only that module and supplies the same map to Emscripten and pthread startup.
Unknown assets fail without fetching a URL inferred from `import.meta.url`. The Provider keeps
the URLs alive until native stop and releases them on either failed startup or exit.

The read-only virtual disc preserves `/game/content.<format>`, native seek/read and EOF semantics.
Its facade splits native reads into <=256 KiB portions without a deadline of their own: the public
sync client bounds each network attempt and waits through outages. Only that client caches blocks. Native stop runs while content remains available, then
the reader closes. Forced Provider shutdown revokes the shared slot and wakes blocked readers.
Contract/schema/error-number files in `libretro/retrom/content-io-v1` are immutable mirrors for
ABI checking, not a second implementation of transport or storage.

`ppsspp-game-save-v1` contains a little-endian uint32 JSON-header length, the UTF-8 header, then
native file bytes in header order. The header declares version, disc SHA-256, virtual PSP MAC and
relative memory-stick paths/sizes/timestamps. The isolated instance's `/save` includes all native
slots, metadata and icons, plus games' direct memory-stick files outside `PSP/SAVEDATA`.
`PSP/SYSTEM`, `PSP/NAND`, `PSP/PPSSPP_STATE` and `.nomedia` markers are excluded from observation,
export and restore. Paths, duplicates, file count (4096), truncation, total size (256 MiB)
and header size (1 MiB) are checked. Files and MAC are restored before boot; no emulator state is
serialized or loaded. Public gzip is applied exactly once by retrom-runtime.

The host exposes native checkpoint availability and acknowledges only the exact exported bytes
after durable persistence. Identical content has one revision, independent of native write count
or timestamps. No progress means no initial checkpoint; deletion of existing progress can export
an empty file set. FS mutation observation covers direct sceIo write/truncate/rename/delete as
well as utility savedata. Writable handles and SaveIO/AsyncIO completion block partial exports.
The native readiness check only reports pending IO. It never pauses emulation or drains a render
frame: the emulation thread can stop before producing another frame, making a synchronous drain
wait forever. Native FS mutations proxy to the emulation worker, which copies the complete tree
synchronously before awaiting its digest. Worker ticks and commands share one serialized queue;
the main-thread availability getter reads only cached status.

Presented-frame counts come from non-null libretro video callbacks and are published on every
submission, independently of worker tick count. Worker pacing uses the core's AV interval and an
absolute deadline to avoid accumulating timer rounding error.
Each tick enters through a MessageChannel task so short or overdue deadlines do not accumulate
Chromium's 4 ms minimum for nested timers. Positive deadlines still sleep, and paused polling
stays at 100 ms; stop cancels the timer and closes both channel ports.
PCM starts with 100 ms of jitter buffering and remains contiguous; bounded playback-rate
correction (±2%) absorbs clock drift
without stopping the playing queue. Only pause, stop and a real underrun restart that queue.

Keyboard controls map to physical PSP buttons: X is Cross, Z is Circle, Enter is Start,
and right Shift is Select. The game decides which button confirms; Start is not a universal
confirmation key. Focus the game canvas before sending keyboard input.

Measure normal gameplay without an attached browser debugger. Opening DevTools can replace
optimized Wasm with debugging code and reduce both emulation speed and PCM supply.
Performance recording can enable optimized code again, so record the debugger/profiler state
alongside measurements. See the [V8 compilation pipeline](https://v8.dev/docs/wasm-compilation-pipeline).

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
direction/confirm, audio, pause, in-game save, native export, different-launch in-game load, continued input,
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
