# Client performance comparison — 23 October 2026

The camera benchmark uses **3104,3508,0**, with **117 HD, GPU, Animation Smoothing
and Camera enabled**. This branch reduces render-thread work while preserving the
requested quality. These are browser stress tests, not a physical Windows reproduction.

## Builds and method

- Current-main baseline: `d09aaeceba48fa6b21294c25e06f78841c6924e1`, production
  `main.a5c1c569.js` (SHA256 `58cb2ab8024d03bc8d02946fb22d88fa534815ccf2ab391a6cf19f23bc19fd6f`).
- Performance product source: `bebd1a740`, production `main.35179182.js`. This is the deployed product; the following
  documentation commit does not change its code.
- Main advanced since the previous capture. Its complete client source tree is byte-identical
  to `01a1770e9`; its server was rebuilt at the new head for these fresh captures.
- Apple M5 Pro, native Apple Metal WebGPU, Chrome 156 headless; four existing cache
  workers and cross-origin isolation in both builds. The cache manifest, indexes
  and dat2 file matched byte for byte. Separate worktree servers used a copied
  test-account save at the same position.
- Draw distance 25, 4× MSAA, GPU FPS limit 240, all HD options enabled, DPR 1.
  The native canvas and scene viewport were 1234×633. The resolution stress case
  rendered 2468×1266 while retaining the same CSS size: four times as many pixels.
- Each case warms for 16 seconds, then records four eight-second windows in
  idle/turn/turn/idle order. The first 1.5 seconds of each window are excluded.
  Turning supplies 512 yaw units/second through the accumulated camera-drag input.
  The tables pool the two turning windows. Builds, tests and other QA browsers
  were paused or closed during measurements.

The checked-in driver is `client/tests/camera-pan-benchmark.browser.cjs`. Log in
on the worktree's own port, dismiss the Welcome Screen, teleport the test account
to the stated position through its own agent MCP, and enable the four plugins:

```sh
CDP_PORT=9333 CPU_SLOWDOWN=1 RENDER_SCALE=1 node client/tests/camera-pan-benchmark.browser.cjs /tmp/camera-native.json
CDP_PORT=9333 CPU_SLOWDOWN=6 RENDER_SCALE=1 node client/tests/camera-pan-benchmark.browser.cjs /tmp/camera-cpu6.json
CDP_PORT=9333 CPU_SLOWDOWN=1 RENDER_SCALE=2 node client/tests/camera-pan-benchmark.browser.cjs /tmp/camera-scale2.json
```

Use the same driver in both checkouts. Its SHA256 for these captures is
`f4d4ca684ebf2bb0fe1d36e9d47ed521b8039ee2895ad0f2bf639a4f07634cd2`.
[Chrome CPU throttling](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setCPUThrottlingRate)
and extra pixels are stress cases, not an emulation of the reporting Windows
CPU/GPU, its driver, or Android hardware. Both native cases reached the headless
browser's 60 Hz ceiling despite the client's 240 FPS setting.

## Camera results

| Turning workload | Metric | Current main | Performance branch |
| --- | --- | ---: | ---: |
| Native | Render CPU mean | 5.31 ms | 1.72 ms |
| Native | Render CPU p95 / p99 | 8.81 / 12.34 ms | 2.46 / 3.39 ms |
| Native | FPS | 60.00 | 60.00 |
| 6× CPU slowdown | Render CPU mean | 24.59 ms | 7.04 ms |
| 6× CPU slowdown | Render CPU p95 / p99 | 39.88 / 65.80 ms | 8.79 / 11.23 ms |
| 6× CPU slowdown | FPS | 35.46 | 60.00 |
| 6× CPU slowdown | Frame interval p95 | 50.00 ms | 16.67 ms |
| 6× CPU slowdown | Frame gaps above 25 ms | 253 | 0 |
| Four times the pixels | Render CPU mean | 4.79 ms | 1.26 ms |
| Four times the pixels | Render CPU p95 / p99 | 6.92 / 14.04 ms | 1.88 / 2.22 ms |
| Four times the pixels | FPS | 60.00 | 60.00 |

All six captures recorded zero rendering errors. Native and pixel-stress cases
reached the headless browser's 60 Hz ceiling. CPU measurements include synchronous
submission and the same counters in both builds; worker CPU time is excluded.
Moving pose construction onto workers removes its main-thread cost, not its total work.

### Work submitted in native turning frames

These averages compare runs where both builds delivered the same frame rate.
They cover WebGPU passes; the separate WebGL widget canvas is excluded.

| Work per frame | Current main | Performance branch |
| --- | ---: | ---: |
| Indexed draw submissions | 543.87 | 228.73 |
| Submitted index elements, including instances | 545,529 | 432,188 |
| Pipeline binds | 77.21 | 40.16 |
| queue.writeBuffer calls | 16.95 | 13.96 |
| queue.writeBuffer source bytes | 234,036 | 81,918 |
| Main-thread NPC pose-mesh builds | 7.01 | 0.00 |

Grass rebuilt 12 times across main's two native turning windows and zero times
on the branch. Submission counts and payload bytes are API work measurements,
not GPU bandwidth, utilization or execution time. GPU timestamp experiments were
excluded from the matched captures; overlapping pass intervals must not be summed
as total GPU frame time.

Captures ran sequentially with moving actors. End snapshots contained 16 active
NPCs on main versus 17 on the branch. Main processed nine map squares versus six
on the branch at the same requested distance; the branch skips unnecessary outer
squares. Viewports, GPU settings and all HD options matched exactly. Residual
live-scene and cache variation remains.

## NPC poses, HD caches and remaining spikes

- WebGPU NPCs reuse player label poses and rest meshes for eligible fractional
  keyframes. Skeletal, alpha/colour-changing and integer-truncated poses fall back.
  Jointed HD normals must be rebuilt to preserve lighting, so those models use the
  worker path; no approximate HD lighting was shipped.
- Unsupported poses build on existing cache workers. Queues are bounded and
  current/base requests take priority over prefetch. At most two existing workers
  build poses in parallel; single-worker clients remain serial. Pool reservations
  retain foreground task ownership through cancellation and shutdown. Completed
  geometry transfers
  into the existing 16 MiB CPU cache. Previous poses and neutral bases remain usable
  during misses; active neutral bases stay recent within the existing cache budget.
  Actor despawn, content changes, old replies and missing sequence data are covered.
- Worker sparse retry collectors attach only during actual foreground task passes.
  NPC jobs can run during foreground JS5 waits without contaminating those passes
  or publishing partial geometry. Existing deadlines and progress checks remain.
- HD mist reuses unchanged terrain targets while continuing easing each frame.
  HD lights cache stable location/height inputs while retaining their animation.
  Sixty stationary frames use 81 rather than 4,860 mist height reads; light tests
  reduce CSR reads 287,160→4,786 and loc/height reads 9,720→162 with identical outputs.
- Real-cache checks cover 212 GPU candidate poses and 268 worker-built poses.
  GPU position error stays below 1/1024 model unit; the 24 actual WebGPU shader
  passes read back 41,904 vertices with maximum error 0.000016 and zero errors.
  Worker geometry matched all four arrays exactly: 5,272,168 bytes.

Gameplay checks observed both pose workers. With downloaded data warm and pose
caches cleared, native first appearances took at most 18 ms; advancing requests
held a displayed pose for at most 34 ms in that native run. Two CPU6 runs observed
maximum holds of 66 and 49 ms, versus 156 ms in the serial diagnostic. These are
short live-scene observations, not latency bounds. No actor lifetime had a draw
gap after its first appearance. Despawn/reused indices are counted separately.

The follow-up CPU6 profile contains no synchronous NPC mesh builds on the render
thread and no steady-state long tasks. Remaining work is mainly widget drawing,
culling and submission. GC accounts for less than 1% of sampled wall time.
Shadow refreshes do not explain the worst remaining frames. Broader UI invalidation
or shader-quality changes were not added without a demonstrated benefit.

## World map and correctness

The earlier matched world-map comparison used the preceding performance product
`849ab16fc` and main `01a1770e9` (whose client source is unchanged on current main).
The same 15 archive tiles (`x=48..52`, `y=49..51`, ppi 2) were requested three
times per build, with decoded map caches cleared between runs and JS5 bytes/image
dependencies already warm. Rendering and client ticks were paused without
disposing the renderer. No JS5 downloads occurred inside the measured runs.

| World-map result | Current main | Performance branch |
| --- | ---: | ---: |
| All 15 tiles complete | 29.30–30.73 ms | 29.11–31.91 ms |
| Largest gap in a 5 ms main-thread timer | 15.86–18.15 ms | 5.45–6.12 ms |

Warm tile completion time is unchanged; moving rasterization to an existing
worker improves main-thread responsiveness. All 983,040 pixel bytes and all icons
matched across both builds and every run. Aggregate SHA256:

- Pixels: `c7549b21f294ad6913a210df1ce5e66aaa56309083c52727c3df46417c3dade7`
- Icons: `7620de797f89c6226813381c1d38a2fade54f78cf76a647ccbc94e8cb2290c0b`

Earlier isolated checks for the preceding batch:

- Four frozen views at the reported location compared GPU-resident NPC pose reuse
  against CPU rebuilding with an empty CPU cache: every 3,124,488-byte view matched,
  each had positive NPC pixel coverage, and CPU builds fell 14→0 per view.
- Matching opaque crowds preserve pixels while batching 100→1 WebGPU draws
  (HD shadow plus scene: 200→2) and 10→1 WebGL draws. Eight GPU base/HD/MSAA
  NPC/player cases had positive actor coverage and exact readback agreement.
- The ordered UI batch matches the original current-main renderer byte for byte
  on the open world map: 588→160 renderer draws. Controlled 6× CPU full redraws
  averaged 20.77→17.78 ms. Its tradeoff is 167,328 additional vertex-upload bytes
  per full redraw; normal camera updates need only their damaged UI regions.
- The integrated mixed-texture UI readback matches individual submissions,
  67→11 draws, including alpha, filtering, clipping, rotation, masks and deletion
  of a previously bound batch texture. Zero GL errors.
- Large-region geometry copies are bounded to 256 KiB per call and 2 MiB per
  preparation step, with a 2 ms cooperative budget. An actual large WebGL instance
  previously copied up to 37.3 MB in one call; staged GPU readback matched all
  65,977,344 incoming geometry bytes. Complete scene publication is retained.
- Geometry exports retain used bytes only. A real IndexedDB legacy-entry check
  preserved every byte while compacting and rewriting its oversized backing
  arrays; it did not clear existing saved caches.
- The integrated world-map UI settled at zooms 50/100/25/100 with zero failed or
  pending tiles. Single-worker/LAN, stale request cancellation, cache reset and
  foreground-scene priority were also checked.
- The integrated Android-user-agent LAN path used WebGL, one worker and no shared
  buffers. With 4× MSAA and a 482×234 scene resolved into an 804×390 canvas,
  16 camera frames produced 16 distinct images and yaw angles without GL errors.
  Its single-worker world-map pixels/icons also matched current main exactly.

## Validation and limits

The complete client suite passed **225 files, zero failures, zero skips**. Final
affected pose/retry suites, typecheck and production builds also passed. Main's
client source/build is unchanged from the earlier successful build/typecheck; its
suite had 196 passing files and one existing deleted-`ConstructionData` import
failure. The current-main server was rebuilt successfully for the new captures.

The single-worker secure WebGPU path also retained visible NPCs through cold pose
caches (maximum first use 17 ms, hold 50 ms in the final observed run). Its path and
insecure-LAN WebGL also matched all
983,040 world-map pixel bytes and icons across three runs. Non-HD gameplay used
GPU poses for 17 observed NPC lifetimes without draw gaps after first appearance.
Android-UA WebGL with one worker, no shared buffers and 4× MSAA rendered 16 distinct
camera images/yaws. One INVALID_OPERATION occurred in the first capture immediately
after AA configuration; the repeat and three per-call-traced AA/plugin toggle
cycles recorded zero errors. Its cause remains unconfirmed; no speculative fix
was added.

Worker poses can lag requests while data or jobs are pending. GPU rest meshes,
textures and final region metadata can still require synchronous initialization.
Preparing a replacement keeps the old scene alive until publication. Physical
Windows/Android frame pacing and peak transition memory remain unverified.

Raw latest artifacts: `/tmp/main-nextbatch-camera-{native,cpu6,scale2}.json`,
`/tmp/tsps-nextbatch-camera-{native,cpu6,scale2}.json`,
`/tmp/tsps-nextbatch-main-comparison.json`,
`/tmp/tsps-npc-cadence-two-*.json`, `/tmp/world-map-nextbatch-lan.json` and
`/tmp/tsps-nextbatch-npc-gpu-readback.json`.

## RLHD comparison follow-up (23 October)

Four additional changes were based on the current RLHD zone renderer:

- WebGPU actor preparation rejects previously measured CPU poses outside both the
  camera and current HD shadow frusta. Bounds include opaque/alpha vertices,
  fractional positions, yaw and terrain heights. Unknown/GPU-label poses and
  deck-local coordinates stay visible. This does not remove simulation or GFX
  ownership. The nearby benchmark NPCs were retained by the shadow volume: this
  is not a claim that actor culling speeds up this particular crowd.
- Evicted actor GPU buffers enter an exact-size/usage pool after the previous frame
  has been submitted. Queue-ordered uploads preserve in-flight reads. The idle
  pool is capped at 16 MiB and releases all buffers on disposal; existing live
  geometry cache limits remain unchanged.
- Scene construction yields between 8×8 terrain chunks, instance chunks and loc
  groups, and cancels superseded WebGPU normal/instance/boat builds. Shared vars,
  NPC snapshots and custom content update only after a foreground build settles,
  so yielding cannot produce mixed-input geometry or poisoned persisted records.
  Nearby scene publication remains atomic. This is granular construction and
  cancellation, **not** a complete independently reusable RLHD zone cache.
- WebGPU scenery replays stable command lists in render bundles. Lists are split
  into at most 32-range sections, preserving order while limiting animation
  invalidation. Visibility/roof/LOD/animation changes still take effect immediately;
  resource and pipeline changes replace recordings. Continuously changing lists
  use direct submission until a list repeats. The benchmark counts replayed draws
  separately from draw calls encoded in JavaScript.

The initial whole-batch bundle prototype regressed CPU time when a single animated
loc invalidated a large shadow batch; it was replaced before the final captures.
In six alternating CPU×6 panning windows on the same final build, bundle submission
averaged **7.58 ms** versus **7.87 ms** for direct submission of the same command
lists (about 3.6%). This isolates bundle replay, not every change in this batch.
It is a small local result, not a physical-device FPS guarantee.

Five paired warm Lumbridge builds produced identical complete `SdMapData`, including
all geometry arrays, draw/LOD ranges, bridge/picking data and minimaps. Cooperative
scheduling added approximately 0.4–1.9% mean elapsed time across the two local runs.
The 8 ms yield target is not a hard cap: individual synchronous lighting/model
operations still produced gaps up to 80.4 ms. The benefit is accepting cancellation
between smaller units without exposing partially built nearby regions.

### Fresh comparison with main

Main was rebuilt at `f3ab3c172deb9fb96360198bc7ae32cff4052f3e`. Candidate rendering
was `28f2788c9`; the subsequent worker input gate changes only build-time update
ordering. The same driver SHA-256
`662964c3c017c5fb6a838b7eea614a0e6cca147df2b73b381309e598b607ddfe`
ran both clients: 3104,3508,0, the four requested plugins, distance 25, 4× MSAA,
FPS limit 240, 16 seconds warm-up, four 4-second idle/drag/drag/idle windows,
discarding 1.5 seconds per window. The following combines both drag windows.
Only one benchmark client rendered at a time; builds/tests were stopped for the
final captures. Both fresh browsers delivered 60 Hz; earlier exploratory captures
had a 30 Hz callback ceiling and are not used in this table.

| Render-thread metric | Main f3ab3c172 | Candidate |
| --- | ---: | ---: |
| Native CPU mean | 5.27 ms | 1.96 ms |
| Native CPU p95 / p99 | 9.02 / 13.36 ms | 2.98 / 3.59 ms |
| Native FPS | 60 | 60 |
| CPU×6 CPU mean | 25.79 ms | 7.09 ms |
| CPU×6 CPU p95 / p99 | 41.04 / 64.69 ms | 8.94 / 10.93 ms |
| CPU×6 FPS | 33.4 | 60 |
| CPU×6 frame gaps above 25 ms | 99 | 0 |
| Four times pixels CPU mean / p95 | 4.14 / 5.31 ms | 1.35 / 1.65 ms |
| Four times pixels FPS | 60 | 60 |
| Native executed indexed draws/frame | 533.84 | 225.10 |
| Native encoded indexed draw calls/frame | 533.84 | 125.37 |
| Native submitted indices/frame | 534,632 | 420,635 |
| Native GPU buffer creations/frame | 10.32 | 0.00 |
| Native buffer upload bytes/frame | 203,783 | 97,939 |

These are **whole-PR** differences, not gains attributable solely to the four new
changes. GPU API counts and CPU submission time are not GPU execution timing or
total system CPU (worker work is excluded). The candidate retained the user's local
upstream-117HD texture preview; main used its committed texture pack. That same texture pack is now included in this PR, replacing the custom
photographic pack. Thus this is a comparison of the
actual local test builds, not an isolated GPU texture-quality experiment. Live NPC
populations and retained outer maps can differ. The 60 Hz ceiling limits FPS claims;
CPU throttling and larger targets do not emulate the player's Windows GPU.

The Android-UA LAN WebGL check used one worker, no shared buffers and 4× MSAA:
16 panning frames produced 16 distinct images/yaws, with no GL errors. Its world-map
check matched all 983,040 pixels and icon hashes across three runs. This is browser
emulation, not testing on a physical Android tablet.

Artifacts: `/tmp/{main,tsps}-rlhd-final-{native,cpu6,scale2}.json`,
`/tmp/tsps-rlhd-main-comparison.json`, `/tmp/tsps-rlhd-bundle-ab.json`,
`/tmp/zone-build-{benchmark,final}.log`, `/tmp/tsps-rlhd-android-camera.json`,
`/tmp/tsps-rlhd-worldmap-webgl.json`.

Final integration validation at `ce46cfb7a`: **229 client test files passed, zero
failures/skips**, plus typecheck and production build. The 3102 preview serves
`main.7c24090b.js` with the retained upstream texture preview. A live teleport away
and back cancelled two obsolete builds and returned to 3104,3508 with scene ready,
zero pending/loading jobs and zero GPU errors. Final-build WebGPU world-map pixels
and icons also matched all three reference runs. Temporary benchmark servers and
browsers were stopped; the user's 3102 stack stays running.

### Main sync after the benchmark

Main advanced to `14f83a1b4` (PR #869, contextual camera controls) after the
`f3ab3c172` comparison above was captured. The controls were merged while preserving
continuous fractional pinch, foreground widget wheel ownership and the camera
performance changes. Focused validation passed all 11 contextual controls, native
Settings wheel, first-person reticle, viewport, pinch and camera test files, plus
client typecheck. The table remains the captured `f3ab3c172` comparison; it was not
rebenchmarked after merging the contextual controls.
