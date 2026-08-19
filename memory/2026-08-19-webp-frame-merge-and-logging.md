# 2026-08-19 WebP Frame Merge Fix + Structured Logging

## Objective

- Resolve issue #24 (`Encoder output contract verification failed` for some
  preserved animated GIFs) and give the processor structured production logs.

## User-Approved Scope

- Fix the verification, keep the sanitization contract; do not drop the
  decode-once raw fan-out.
- Use a mature logging library (pino) rather than a hand-rolled logger.
- Post-fix: regroup the flat `src/` folder by ownership (done, see below).

## Implementation Status

- Completed: root-cause analysis, verification fix, manifest correctness,
  pino logger + `LOG_LEVEL`, structured failure logs, regression tests,
  README/CHANGELOG (`Unreleased`).
- Partial: none.
- Not started: version bump/tag for the release.

## Root Cause (verified empirically, sharp 0.35.3 / libvips 8.18.3 / libwebp 1.6.0)

- libwebp `WebPAnimEncoder` skips a frame whose change-rect against the previous
  canvas is empty and adds its delay to the previous frame; for lossy output
  "identical" means per-channel diff <= `QualityToMaxDiff(quality)` (~4 at q80).
  If everything collapses to one frame the file is a *still* WebP.
- No sharp/libvips option disables this (`minSize`, `mixed`, `lossless` tested).
- sharp `toBuffer` `info.pages` is the pipeline INPUT page count, not the encoded
  one, so `verifySanitizedOutput` (`pages === expected`) failed.
- sharp resizes an animation as one tall strip, so identical neighbours can stop
  being identical after resize; merging therefore shows up mostly on non-resized
  outputs, which is why only some outputs / some GIFs failed.
- The issue's 16,383-pixel stacked-height hypothesis was refuted: 81/82/86/100
  unique 200x200 frames round-trip intact through the raw fan-out.

## Source Restructure (after the fix commit `c6c823e`)

- `git mv` only, plus relative-import rewrites; no logic change.
- `src/http/` app, multipart, concurrency; `src/image/` pipeline (was
  `image.ts`), recipe, source-metadata; `src/video/` transcode (was
  `video.ts`); `src/contracts/` schemas (was `contracts.ts`); `src/config/`
  config, policy, env, build-info, runtime; `src/shared/` errors, deadline,
  detect, logger, canonical-json, types. Tests moved beside modules
  (`contract.test.ts` -> `contracts/schemas.test.ts`, its `import.meta.url`
  paths gained one `../`). `scripts/*.ts` and README paths updated.

## Major Changes

- Files/modules: `src/image.ts` (`verifySanitizedOutput` now takes an
  `OutputContract`, returns `VerifiedOutput`, accepts `1 <= pages <= input
  pages`, logs expected/actual on failure, manifests use encoded values;
  `normalizeSharpError` logs the underlying error), `src/logger.ts` (new),
  `src/app.ts` (`handle(route, op)` logs rejected requests / unexpected
  errors), `src/index.ts` (startup log), `src/video.ts` (`runProcess` logs
  failed children with bounded stderr tail).
- API / interface changes: none on the wire; output manifest `pages`/`animated`
  may now be smaller than source pages for preserved animations. Problem title
  for contract failures now lists the violated fields, e.g.
  `Encoder output contract verification failed (pages)`.
- Config / environment changes: optional `LOG_LEVEL`
  (`fatal|error|warn|info|debug|trace|silent`, default `info`, `silent` under
  `NODE_ENV=test`, invalid values fail startup).
- Tests: `image.test.ts` merged (`AABBA` -> 3 pages, delays summed), collapsed
  (`AAA` -> still WebP), 86 unique 200x200 frames; `logger.test.ts`.

## Validation

- Commands run: `bun test` (90 pass), `bun run typecheck`, `bun run build`,
  prettier on touched files.
- Result: passed.
- Skipped checks: `bun run contracts:check` and repo-wide `fmt:check` fail on
  this Windows checkout because `core.autocrlf=true` rewrites files to CRLF;
  they fail identically on untouched `main` and pass in CI (Linux). Docker
  smoke not run.

## Remaining Work

- Known gaps: decide version (patch `0.3.2` seems right:
  no wire change) and move `Unreleased` in CHANGELOG.
- Risks: callers that assumed `outputs.*.pages == source.pages` for preserved
  animations must read the per-output value.
- Suggested next entry points: `src/image.ts` `verifySanitizedOutput`,
  `src/logger.ts`.

## Notes For Next Agent

- Test fixtures need `gif({ keepDuplicateFrames: true })` — libvips gifsave
  also dedups identical frames by default. GIF delays < 20 ms are normalized
  to 100 ms by the loader; use >= 20 ms in timing assertions.
- Do not reintroduce an exact page-count equality check.
