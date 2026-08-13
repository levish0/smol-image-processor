# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-08-13

### Added

- Operator-owned `FFMPEG_ADDRESS_SPACE_LIMIT_BYTES` configuration with strict
  positive safe-integer startup validation.
- Health diagnostics for the effective child address-space fence.
- Unit and hardened-container coverage for the default profile, a larger valid
  operator value, malformed values, and startup rejection.

### Changed

- The existing 768 MiB ffmpeg/ffprobe address-space fence is now the reviewed
  default rather than a universal compiled maximum. Container RAM and swap
  remain deployment-orchestrator settings rather than processor configuration.

## [0.3.0] - 2026-08-13

### Added

- Versioned `POST /v1/images/process` multi-output recipe API.
- RFC 8785 canonical `multipart/related` responses with exact RFC
  `Content-Digest`, recipe/build fingerprint, byte-length, MIME, geometry,
  frame, and derived Content-ID binding for every output.
- Generated JSON Schema contracts and a neutral responsive-image example.
- Bounded EXIF allowlist extraction with all extracted fields classified as
  restricted, while sanitized outputs strip EXIF/XMP/IPTC/ICC metadata.
- Streaming multipart envelope accounting, idle/whole-request deadlines,
  fail-closed immutable ceilings, separate logical/form limits, shared admission,
  response-lifetime leases, bounded encoder concurrency, cancellation, and
  aggregate budgets.
- Fixed-capacity multipart file coalescing so tiny transport chunks cannot
  amplify request memory through per-chunk objects.
- Explicit `reject`, `preserve`, and `first_frame` animation policies.
- Typed generated problem-response schema and stable status/code union.
- Explicit `POST /v1/videos/process` route.

### Changed

- Image fan-out decodes one auto-oriented sRGB RGBA raw base and uses bounded,
  fail-fast output encoders with all-or-nothing publication.
- Video admission now fences codec/pixel format, dimensions, frame rate, decoded
  pixels and working-set memory, coded dimensions, diagnostics, temp output
  bytes, and chapter/stream metadata. Linux ffmpeg/ffprobe children run under a
  fixed address-space fence, and the supported 2 GiB container profile is
  exercised with an exact-maximum 100 MiB video request.
- Video presets are restricted to the bounded `ultrafast`, `superfast`, and
  `veryfast` profiles, with `veryfast` as the default.
- The Bun listener idle timeout is derived above the selected whole-job
  deadline so long-running valid processing is not cut off by the server.
- The application factory is separate from the process listener so HTTP behavior
  can be tested in-process.
- CI checks generated contract drift and TypeScript types; release publication
  pushes the exact image that passed full response verification in a read-only,
  non-root container.
- The runtime image and Bun toolchain are pinned to Bun 1.2.20.

### Removed

- **Breaking:** removed generic `POST /process` and all `x-media-*` response
  headers. There is no v0.2 compatibility route.

## [0.2.0] - 2026-06-22

### Added

- Video processing: `POST /process` now detects videos and normalizes them to MP4 (H.264/AAC) via ffmpeg, with source metadata stripped, dimension downscaling, and duration/size limits.
- Magic-byte media detection so the processor routes uploads by content rather than the client-supplied type.
- Video environment variables: `MAX_VIDEO_INPUT_BYTES`, `MAX_VIDEO_OUTPUT_BYTES`, `MAX_VIDEO_DURATION_SECONDS`, `MAX_VIDEO_DIMENSION`, `VIDEO_TIMEOUT_SECONDS`, `VIDEO_CRF`, `VIDEO_PRESET`, `VIDEO_AUDIO_BITRATE_KBPS`.
- Video and detection test coverage.
- `ffmpeg` is installed in the Docker image.

### Changed

- Renamed the project from `smol-image-processor` to `smol-media-processor`.
- Generalized the codebase into `env`, `errors`, `types`, `detect`, `image`, `video`, and `media` modules; `ImageProcessingError` is now `MediaProcessingError`.
- Response headers are now generalized to `x-media-*` (previously `x-image-*`) with kind-specific extras. **Breaking** for clients reading the old `x-image-*` headers.

## [0.1.1] - 2026-06-05

### Added

- Added processor coverage for EXIF orientation, animated WebP metadata, animation timing, alpha preservation, and `MAX_PAGES` boundary behavior.
- Added default option coverage for strict integer environment variable parsing and bounded WebP option clamping.

### Changed

- Tightened processor environment variable parsing to ignore partial integer strings such as `12px` or `15.9`.
- Consolidated Sharp input setup used by metadata reads and image processing.

## [0.1.0] - 2026-06-05

### Added

- Initial Bun/Elysia image processor service.
- Multipart `/process` endpoint that normalizes JPEG, PNG, GIF, and WebP inputs to WebP.
- `/health` endpoint.
- Docker image build.
- GitHub Actions checks and GHCR publishing workflow.
