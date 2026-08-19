# smol-media-processor

A small private Bun/Elysia helper for bounded, versioned media transforms. It
owns no database, object-store credential, authorization rule, or
consumer-specific rendition preset.

Version 0.3 exposes explicit image and video endpoints. The generic v0.2
`POST /process` endpoint and `x-media-*` contract no longer exist.

## Image contract

`POST /v1/images/process` consumes `multipart/form-data` with exactly two
parts:

- `file`: one JPEG, PNG, GIF, or WebP file.
- `recipe`: `application/json` conforming to
  [`image-recipe-v1.schema.json`](contracts/image-recipe-v1.schema.json).

Output IDs are object keys, so identity is unique before processing:

```json
{
  "schema_version": 1,
  "animation_policy": "reject",
  "outputs": {
    "small": {
      "format": "webp",
      "resize": {
        "mode": "inside",
        "width": 320,
        "allow_upscale": false
      },
      "quality": 85,
      "effort": 4
    },
    "large": {
      "format": "webp",
      "resize": {
        "mode": "inside",
        "width": 1600,
        "allow_upscale": false
      },
      "quality": 85,
      "effort": 4
    }
  }
}
```

`inside` requires a width, height, or both. `cover` requires both. Version 1
only permits `allow_upscale: false`; raw Sharp options, paths, commands, and
consumer policy names are not accepted.

The successful response is deterministic `multipart/related`:

1. RFC 8785 canonical JSON manifest with `Content-ID: <manifest>`.
2. One `image/webp` part per output in ASCII output-ID order. Output `small`
   always has `Content-ID: <output-small>`.

Every part has `Content-Type`, `Content-Length`, and RFC `Content-Digest`
SHA-256. The manifest additionally binds the input digest, canonical recipe
digest, processor/Sharp/libvips/platform build fingerprint, output bytes,
geometry, frame count, MIME, and SHA-256. It conforms to
[`image-manifest-v1.schema.json`](contracts/image-manifest-v1.schema.json).
There is no partial success.

### Decode and animation

The processor checks dimensions and all decoded/output budgets with `BigInt`
before pixel materialization. It then decodes compressed pixels exactly once to
an auto-oriented sRGB RGBA raw base and fans that base out through bounded
encoder workers. Output bytes are counted while encoders stream.
Each image keeps one admission slot until its HTTP response reaches EOF or is
cancelled. A video keeps the entire admission capacity for the same lifetime,
so buffered input, tmpfs artifacts, and output bytes cannot overlap another
large job.

Animation policy is explicit:

- `reject`: animated sources fail.
- `preserve`: all frames and timing are retained within page, duration, raw,
  pixel, byte, and deadline budgets. The animated WebP encoder merges
  consecutive frames that are identical (or, for lossy output, within its
  quality-derived tolerance) into one frame carrying the summed delay, and
  emits a still WebP when every frame collapses; each output manifest reports
  the page count and `animated` flag of the bytes actually served, which may
  therefore be smaller than the source page count.
- `first_frame`: only frame zero is decoded and emitted; the manifest still
  reports the source as animated.

Serving outputs are independently re-read and verified as WebP with the
declared geometry, a page count between one and the source page count, and no
EXIF, XMP, IPTC, ICC profile, or embedded thumbnail. A verification failure
returns a generic `processing_failed` problem while the expected and actual
values are written to the processor log. A bounded
source metadata allowlist is extracted before sanitization and marked
`restricted`; the caller owns any later privacy classification.

## Video contract

`POST /v1/videos/process` consumes exactly one multipart `file`. Supported
containers are normalized to MP4 with H.264, optional AAC, `+faststart`, no
upscale, and source/global/stream/chapter metadata removed.

ffprobe admission checks codec, 8-bit 4:2:0 pixel format, duration, input
dimensions, frame rate, total decode-pixel amplification, and a conservative
192 MiB decoder/reference/filter working-set budget. ffmpeg and ffprobe run
under an operator-selected child address-space fence in addition to the
container memory limit. The reviewed default is 768 MiB. ffmpeg also uses
bounded diagnostics, threads, deadline, and an output-file hard ceiling. The
result is
stat-checked before it is read into memory, then probed again before publication.

Image and video routes stay separate so an image caller cannot accidentally
trigger ffmpeg.

## Errors

Failures conform to
[`problem-v1.schema.json`](contracts/problem-v1.schema.json) as one exact
status/code discriminated union:

| Status | Codes                                                                          |
| -----: | ------------------------------------------------------------------------------ |
|    400 | `invalid_request`                                                              |
|    413 | `limit_exceeded`                                                               |
|    415 | `unsupported_media_type`, `unsupported_format`                                 |
|    422 | `invalid_image`, `invalid_video`, `animation_not_allowed`, `processing_failed` |
|    503 | `processor_overloaded`, `processor_unavailable`                                |
|    500 | `internal_error`                                                               |

Sharp/libvips/ffmpeg messages and source metadata are never returned.

`Content-Length` is only an early hint. The parser counts actual streamed
multipart bytes, rejects trailing/incomplete data, and enforces both an idle
timeout and one whole-job deadline that remains active through response EOF or
cancellation. Logical file and multipart envelope limits remain separate.

## Checked contracts

[`src/contracts.ts`](src/contracts.ts) is the TypeBox source of truth for JSON
Schemas and TypeScript wire types. Checked JSON is generated:

```bash
bun run contracts:generate
bun run contracts:check
```

CI fails on drift. The example under [`contracts/examples`](contracts/examples)
is deliberately generic; each consumer owns its own versioned recipe selection.

## Run and validate

```bash
bun install --frozen-lockfile
bun run check
bun start
```

ffmpeg, ffprobe, and prlimit must be on `PATH`. The default port is `6701`.
Logs are structured JSON lines on stdout (pino); `LOG_LEVEL` selects `fatal`,
`error`, `warn`, `info` (default), `debug`, `trace`, or `silent`, and an
unknown value fails startup. Rejected requests, encoder contract violations,
underlying libvips diagnostics, and ffmpeg/ffprobe failures (bounded stderr
tail) are logged with structured fields; problem responses stay generic.
Production startup is fail-closed on non-Linux platforms or when any of these
runtime dependencies is unavailable. Direct Windows/macOS execution remains a
development and unit-test convenience, not a supported production profile.

## Resource limits

Reviewed defaults are compiled in. Except for the explicitly operator-owned
FFmpeg address-space profile, a present environment value may reduce a ceiling
but cannot expand it. Malformed, non-positive, or out-of-range values fail
startup instead of falling back or clamping.

| Name                                  |        Default |                            Hard maximum |
| ------------------------------------- | -------------: | --------------------------------------: |
| `PROCESSING_CONCURRENCY`              |              2 |                                       2 |
| `ENCODER_CONCURRENCY`                 |              2 |                                4 global |
| `REQUEST_IDLE_TIMEOUT_SECONDS`        |             10 |                                      30 |
| `MAX_RECIPE_BYTES`                    |         65,536 |                                  65,536 |
| `MAX_RECIPE_OUTPUTS`                  |              8 |                                       8 |
| `MAX_RECIPE_DIMENSION`                |          8,192 |                                   8,192 |
| `MAX_IMAGE_REQUEST_BYTES`             |     10,616,832 |                             134,217,728 |
| `MAX_IMAGE_INPUT_BYTES`               |     10,485,760 |                              10,485,760 |
| `MAX_IMAGE_INPUT_PIXELS`              |     32,000,000 |                              32,000,000 |
| `MAX_IMAGE_DECODED_BYTES`             |    128,000,000 |                             128,000,000 |
| `MAX_IMAGE_PAGES`                     |            300 |                                     300 |
| `MAX_IMAGE_ANIMATION_DURATION_MS`     |        300,000 |                                 300,000 |
| `MAX_IMAGE_OUTPUT_BYTES`              |     10,485,760 |                              10,485,760 |
| `MAX_IMAGE_AGGREGATE_OUTPUT_BYTES`    |     33,554,432 |                              33,554,432 |
| `MAX_IMAGE_OUTPUT_PIXELS`             |     32,000,000 |                              32,000,000 |
| `MAX_IMAGE_AGGREGATE_OUTPUT_PIXELS`   |    128,000,000 |                             128,000,000 |
| `IMAGE_PROCESSING_DEADLINE_SECONDS`   |             30 |                                      60 |
| `MAX_VIDEO_REQUEST_BYTES`             |    104,923,136 |                             134,217,728 |
| `MAX_VIDEO_INPUT_BYTES`               |    104,857,600 |                             104,857,600 |
| `MAX_VIDEO_OUTPUT_BYTES`              |    104,857,600 |                             104,857,600 |
| `MAX_VIDEO_DURATION_SECONDS`          |            300 |                                     300 |
| `MAX_VIDEO_INPUT_DIMENSION`           |          8,192 |                                   8,192 |
| `MAX_VIDEO_FRAME_RATE`                |             60 |                                      60 |
| `MAX_VIDEO_DECODE_PIXELS`             | 20,000,000,000 |                          20,000,000,000 |
| `MAX_VIDEO_DECODER_WORKING_SET_BYTES` |    201,326,592 |                             201,326,592 |
| `FFMPEG_ADDRESS_SPACE_LIMIT_BYTES`    |    805,306,368 |                   positive safe integer |
| `MAX_VIDEO_DIMENSION`                 |          1,920 |                                   1,920 |
| `VIDEO_PROCESSING_DEADLINE_SECONDS`   |            150 |                                     180 |
| `VIDEO_CRF`                           |             23 |                                   0..51 |
| `VIDEO_PRESET`                        |     `veryfast` | `ultrafast`, `superfast`, or `veryfast` |
| `VIDEO_AUDIO_BITRATE_KBPS`            |            128 |                                     320 |

`PROCESSING_CONCURRENCY * ENCODER_CONCURRENCY` may not exceed four.
`MAX_*_REQUEST_BYTES` must still fit the selected logical limits plus multipart
overhead.

`FFMPEG_ADDRESS_SPACE_LIMIT_BYTES` is a deployment setting, not a request or
recipe field. It controls each ffmpeg/ffprobe child's virtual address-space
fence and may be set above or below the reviewed 768 MiB default. It does not
configure container RAM or swap and does not promise that every possible video
will fit. The operator owns the matching Docker/Kubernetes memory profile.

## Docker

The release image pins Bun 1.2.20, runs as the unprivileged `bun` user, and only
needs writable `/tmp` for video jobs.

```bash
docker build -t smol-media-processor .
docker network create --internal smp-private
docker run --rm --name smol-media-processor \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --memory 2g \
  --cpus 2 \
  --pids-limit 128 \
  --network smp-private \
  --env FFMPEG_ADDRESS_SPACE_LIMIT_BYTES=805306368 \
  smol-media-processor
```

Attach only the trusted internal caller to `smp-private`; an internal Docker
network deliberately has no host-published port or outbound route.

The tag workflow builds one candidate image, runs the full multipart verifier
against that exact hardened image, and pushes that same image only after it
passes. No independently rebuilt artifact is published.

Deploy privately, without object-store credentials or outbound network access.

The reviewed deployment profile requires a 2 GiB container memory limit. It is
an operator-owned runtime setting, not an API input. Giving the container more
memory does not automatically expand request or processing ceilings; the
operator must also select the FFmpeg address-space fence appropriate for that
deployment. Deployments below 2 GiB are outside the tested profile.

The 2 GiB default profile is deliberately larger than the 768 MiB child
address-space fence. During video processing the Bun process can still hold the
bounded input while `/tmp` contains the bounded input and output objects. The
remaining envelope keeps the HTTP server and health endpoint alive if the child
reaches its own resource fence. Child resource exhaustion returns typed 503 and
cleans up the job; total container OOM remains an infrastructure failure and
must be handled by the container restart policy and the caller's durable retry.

`GET /health` reports the effective `ffmpeg_address_space_limit_bytes` so the
deployment can verify its intended setting before opening traffic.

The release smoke sends an exact-maximum 100 MiB video through the real HTTP
route under this profile, checks the cgroup peak remains below the container
limit, and verifies that the process was not OOM-killed and remains healthy.

## License

MIT
