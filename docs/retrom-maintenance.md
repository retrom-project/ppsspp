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

The host ABI is `ppsspp-host-v2`. The host receives a `SEEKABLE_BLOB` source with URL, exact size,
SHA-256 identity and `rangeRequired: true`. A read-only virtual disc preserves the original
`/game/content.<format>` path and native seek/read semantics without allocating a complete Blob.
A separate I/O worker serves 256 KiB HTTP ranges through a SharedArrayBuffer mailbox. Only the
emulation worker waits; the browser UI and network worker remain responsive. Requests have a
15-second network deadline and the mailbox has a 16-second deadline. Exit wakes waiting reads
and terminates both workers. No speculative full-disc download or fallback to HTTP 200 is allowed.

The I/O worker caches at most 32 blocks in memory, the emulation worker at most 8, plus one shared
transfer block. Cache Storage persists individual blocks by source SHA-256, length, block size and
index, allowing reuse across launches and URLs. Storage failures fall back to bounded network reads.
Each cached block has a locally computed SHA-256 checked on reuse to detect cache corruption.
Network responses must have status 206, exact Content-Range/Content-Length and the source's strong
`"sha256-<digest>"` ETag; requests include If-Match and reject redirects. This trusts the authorized
server's immutable content identity. It does not independently verify the original whole-disc hash
before play: that would require a server-supplied authenticated block-hash manifest. Local block
checksums are not such a manifest. Core executable assets retain complete hash verification in
retrom-runtime. No whole-game LOAD_PROGRESS is emitted for unread data.

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
there to bundle the host, emulation worker and I/O worker into three ESM entry points; internal
source modules are not additional release assets. The resulting manifest remains within the
Provider's existing bounded asset contract.

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
