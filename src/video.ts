import { randomUUID } from "node:crypto";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeadline } from "./deadline";
import { MediaProcessingError, throwIfProcessingAborted } from "./errors";
import { PROCESSOR_POLICY_V1 } from "./policy";
import type { ProcessedMediaBase } from "./types";

export const VIDEO_PRESETS = PROCESSOR_POLICY_V1.video.allowed_presets;

type Preset = (typeof VIDEO_PRESETS)[number];

const ALLOWED_INPUT_FORMATS = new Set([
  "mov,mp4,m4a,3gp,3g2,mj2",
  "matroska,webm",
  "avi",
  "flv",
  "mpeg",
]);
const ALLOWED_VIDEO_CODECS = new Set([
  "av1",
  "flv1",
  "h264",
  "hevc",
  "mpeg1video",
  "mpeg2video",
  "mpeg4",
  "theora",
  "vp8",
  "vp9",
]);
const ALLOWED_DECODE_PIXEL_FORMATS = new Set([
  "nv12",
  "nv21",
  "yuv420p",
  "yuvj420p",
]);
const CONSERVATIVE_DECODE_BYTES_PER_PIXEL = 2n;
const CONSERVATIVE_PIPELINE_FRAME_COUNT = 24n;

const PROCESS_OUTPUT_LIMIT_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MILLISECONDS = 30_000;

export type ProcessedVideo = ProcessedMediaBase & {
  kind: "video";
  mimeType: "video/mp4";
  extension: "mp4";
  durationSeconds: number;
  hasAudio: boolean;
};

export type VideoOptions = {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxDurationSeconds: number;
  maxInputDimension: number;
  maxFrameRate: number;
  maxDecodePixels: number;
  maxDecoderWorkingSetBytes: number;
  maxChildAddressSpaceBytes: number;
  maxDimension: number;
  deadlineMilliseconds: number;
  crf: number;
  preset: Preset;
  audioBitrateKbps: number;
};

const videoPolicy = PROCESSOR_POLICY_V1.video;

export const VIDEO_HARD_LIMITS = {
  maxInputBytes: videoPolicy.max_input_bytes,
  maxOutputBytes: videoPolicy.max_output_bytes,
  maxDurationSeconds: videoPolicy.max_duration_seconds,
  maxInputDimension: videoPolicy.max_input_dimension,
  maxFrameRate: videoPolicy.max_frame_rate,
  maxDecodePixels: videoPolicy.max_decode_pixels,
  maxDecoderWorkingSetBytes: videoPolicy.max_decoder_working_set_bytes,
  maxChildAddressSpaceBytes: videoPolicy.max_child_address_space_bytes,
  maxDimension: videoPolicy.max_output_dimension,
  deadlineMilliseconds: videoPolicy.max_deadline_ms,
  minCrf: videoPolicy.min_crf,
  maxCrf: videoPolicy.max_crf,
  audioBitrateKbps: videoPolicy.max_audio_bitrate_kbps,
} as const;

export const VIDEO_DEFAULTS: VideoOptions = {
  maxInputBytes: VIDEO_HARD_LIMITS.maxInputBytes,
  maxOutputBytes: VIDEO_HARD_LIMITS.maxOutputBytes,
  maxDurationSeconds: VIDEO_HARD_LIMITS.maxDurationSeconds,
  maxInputDimension: VIDEO_HARD_LIMITS.maxInputDimension,
  maxFrameRate: VIDEO_HARD_LIMITS.maxFrameRate,
  maxDecodePixels: VIDEO_HARD_LIMITS.maxDecodePixels,
  maxDecoderWorkingSetBytes: VIDEO_HARD_LIMITS.maxDecoderWorkingSetBytes,
  maxChildAddressSpaceBytes: VIDEO_HARD_LIMITS.maxChildAddressSpaceBytes,
  maxDimension: VIDEO_HARD_LIMITS.maxDimension,
  deadlineMilliseconds: 150_000,
  crf: 23,
  preset: videoPolicy.default_preset,
  audioBitrateKbps: 128,
};

export async function processVideo(
  input: Buffer,
  options = VIDEO_DEFAULTS,
  parentSignal?: AbortSignal,
): Promise<ProcessedVideo> {
  const parent = parentSignal ?? new AbortController().signal;
  const deadline = createDeadline(parent, options.deadlineMilliseconds);
  const signal = deadline.signal;
  throwIfProcessingAborted(signal);
  if (input.length === 0) {
    deadline.dispose();
    throw new MediaProcessingError("invalid_request", "Empty file");
  }
  if (input.length > options.maxInputBytes) {
    deadline.dispose();
    throw new MediaProcessingError("limit_exceeded", "Input is too large");
  }

  const id = randomUUID();
  const inputPath = join(tmpdir(), `smp-${id}.in`);
  const outputPath = join(tmpdir(), `smp-${id}.mp4`);

  try {
    const writtenBytes = await Bun.write(inputPath, input);
    if (writtenBytes !== input.length) {
      throw new MediaProcessingError(
        "processor_unavailable",
        "Temporary storage capacity was exhausted",
      );
    }
    throwIfProcessingAborted(signal);
    const probe = await probeInput(inputPath, options, signal);
    await transcode(inputPath, outputPath, probe.hasAudio, options, signal);
    const output = await readBoundedOutput(outputPath, options.maxOutputBytes);
    throwIfProcessingAborted(signal);
    const outputMeta = await probeOutputMetadata(
      outputPath,
      options.maxChildAddressSpaceBytes,
      signal,
    );

    return {
      kind: "video",
      bytes: output,
      mimeType: "video/mp4",
      extension: "mp4",
      width: outputMeta.width,
      height: outputMeta.height,
      size: output.length,
      durationSeconds: outputMeta.durationSeconds,
      hasAudio: probe.hasAudio,
    };
  } finally {
    deadline.dispose();
    await safeUnlink(inputPath);
    await safeUnlink(outputPath);
  }
}

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  width?: number;
  height?: number;
  coded_width?: number;
  coded_height?: number;
  duration?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  tags?: Record<string, string>;
};

type FfprobeResult = {
  format?: {
    format_name?: string;
    duration?: string;
    tags?: Record<string, string>;
  };
  streams?: FfprobeStream[];
  chapters?: unknown[];
};

type InputProbe = {
  hasAudio: boolean;
};

async function probeInput(
  path: string,
  options: VideoOptions,
  signal: AbortSignal,
): Promise<InputProbe> {
  const result = await ffprobe(path, options.maxChildAddressSpaceBytes, signal);
  const formatName = result.format?.format_name ?? "";
  if (!ALLOWED_INPUT_FORMATS.has(formatName)) {
    throw new MediaProcessingError(
      "unsupported_format",
      `Unsupported video format: ${formatName || "unknown"}`,
    );
  }

  const streams = result.streams ?? [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  if (!videoStream?.width || !videoStream.height) {
    throw new MediaProcessingError(
      "unsupported_format",
      "No valid video stream found",
    );
  }
  const decodeDimensions = resolveVideoDecodeDimensions(videoStream);
  if (
    decodeDimensions.width > options.maxInputDimension ||
    decodeDimensions.height > options.maxInputDimension
  ) {
    throw new MediaProcessingError(
      "limit_exceeded",
      "Video dimensions exceed the input limit",
    );
  }
  const decoderWorkingSet = estimateVideoDecoderWorkingSetBytes({
    width: decodeDimensions.width,
    height: decodeDimensions.height,
    codecName: videoStream.codec_name,
    pixelFormat: videoStream.pix_fmt,
    bitsPerRawSample: videoStream.bits_per_raw_sample,
  });
  if (decoderWorkingSet > BigInt(options.maxDecoderWorkingSetBytes)) {
    throw new MediaProcessingError(
      "limit_exceeded",
      "Video decoder working set exceeds the memory limit",
    );
  }

  const duration = parseDuration(result);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MediaProcessingError(
      "invalid_video",
      "Cannot determine video duration",
    );
  }
  if (duration > options.maxDurationSeconds) {
    throw new MediaProcessingError(
      "limit_exceeded",
      "Video duration exceeds the limit",
    );
  }

  const frameRate = parseFrameRate(
    videoStream.avg_frame_rate ?? videoStream.r_frame_rate,
  );
  if (!Number.isFinite(frameRate) || frameRate <= 0) {
    throw new MediaProcessingError(
      "invalid_video",
      "Cannot determine video frame rate",
    );
  }
  if (frameRate > options.maxFrameRate) {
    throw new MediaProcessingError(
      "limit_exceeded",
      "Video frame rate exceeds the limit",
    );
  }

  const frames = BigInt(Math.ceil(duration * frameRate));
  const decodePixels =
    BigInt(decodeDimensions.width) * BigInt(decodeDimensions.height) * frames;
  if (decodePixels > BigInt(options.maxDecodePixels)) {
    throw new MediaProcessingError(
      "limit_exceeded",
      "Video decode budget exceeds the limit",
    );
  }

  return { hasAudio: streams.some((stream) => stream.codec_type === "audio") };
}

export function resolveVideoDecodeDimensions(input: {
  width?: number;
  height?: number;
  coded_width?: number;
  coded_height?: number;
}): { width: number; height: number } {
  const width = Math.max(input.width ?? 0, input.coded_width ?? 0);
  const height = Math.max(input.height ?? 0, input.coded_height ?? 0);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new MediaProcessingError(
      "invalid_video",
      "Video dimensions are invalid",
    );
  }
  return { width, height };
}

export function estimateVideoDecoderWorkingSetBytes(input: {
  width: number;
  height: number;
  codecName?: string;
  pixelFormat?: string;
  bitsPerRawSample?: string;
}): bigint {
  if (!input.codecName || !ALLOWED_VIDEO_CODECS.has(input.codecName)) {
    throw new MediaProcessingError(
      "unsupported_format",
      `Unsupported video codec: ${input.codecName || "unknown"}`,
    );
  }
  if (
    !input.pixelFormat ||
    !ALLOWED_DECODE_PIXEL_FORMATS.has(input.pixelFormat)
  ) {
    throw new MediaProcessingError(
      "unsupported_format",
      `Unsupported video pixel format: ${input.pixelFormat || "unknown"}`,
    );
  }
  const bits = Number(input.bitsPerRawSample);
  if (Number.isFinite(bits) && bits > 8) {
    throw new MediaProcessingError(
      "unsupported_format",
      "Video bit depth exceeds the 8-bit decode policy",
    );
  }
  return (
    BigInt(input.width) *
    BigInt(input.height) *
    CONSERVATIVE_DECODE_BYTES_PER_PIXEL *
    CONSERVATIVE_PIPELINE_FRAME_COUNT
  );
}

async function transcode(
  inputPath: string,
  outputPath: string,
  hasAudio: boolean,
  options: VideoOptions,
  signal: AbortSignal,
): Promise<void> {
  const args = buildVideoTranscodeArgs(
    inputPath,
    outputPath,
    hasAudio,
    options,
  );

  const result = await runProcess(
    "ffmpeg",
    args,
    options.deadlineMilliseconds,
    signal,
    options.maxChildAddressSpaceBytes,
  );
  if (result.cancelled) {
    throwIfProcessingAborted(signal);
  }
  if (result.timedOut) {
    throw new MediaProcessingError(
      "processor_unavailable",
      "Video processing deadline exceeded",
    );
  }
  if (result.outputExceeded) {
    throw new MediaProcessingError(
      "processor_unavailable",
      "Video processor emitted excessive diagnostics",
    );
  }
  if (result.resourceExhausted) {
    throw new MediaProcessingError(
      "processor_unavailable",
      "Video processor exhausted its resource envelope",
    );
  }
  if (result.exitCode !== 0) {
    throw new MediaProcessingError(
      "processing_failed",
      "Failed to process video",
    );
  }
}

export function buildVideoTranscodeArgs(
  inputPath: string,
  outputPath: string,
  hasAudio: boolean,
  options: VideoOptions,
): string[] {
  const max = options.maxDimension;
  const vf =
    `scale=w='min(${max}\\,iw)':h='min(${max}\\,ih)':force_original_aspect_ratio=decrease,` +
    `scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2'`;
  const outputFileLimit = options.maxOutputBytes + 1;
  if (!Number.isSafeInteger(outputFileLimit)) {
    throw new Error("Video output byte limit is not safe");
  }

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-protocol_whitelist",
    "file",
    "-threads:v:0",
    "2",
    "-i",
    inputPath,
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-map",
    "0:v:0",
    ...(hasAudio ? ["-map", "0:a:0?"] : []),
    "-metadata",
    "title=",
    "-metadata",
    "artist=",
    "-metadata",
    "comment=",
    "-metadata",
    "description=",
    "-metadata:s:v:0",
    "title=",
    ...(hasAudio ? ["-metadata:s:a:0", "title="] : []),
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-threads:v:0",
    "2",
    "-filter_threads",
    "1",
    "-preset",
    options.preset,
    "-crf",
    String(options.crf),
    "-pix_fmt",
    "yuv420p",
    ...(hasAudio
      ? ["-c:a", "aac", "-b:a", `${options.audioBitrateKbps}k`]
      : ["-an"]),
    "-movflags",
    "+faststart",
    "-fs",
    String(outputFileLimit),
    "-f",
    "mp4",
    outputPath,
  ];
  return args;
}

async function ffprobe(
  path: string,
  maxAddressSpaceBytes: number,
  signal: AbortSignal,
): Promise<FfprobeResult> {
  const result = await runProcess(
    "ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "-show_chapters",
      "-protocol_whitelist",
      "file",
      path,
    ],
    PROBE_TIMEOUT_MILLISECONDS,
    signal,
    maxAddressSpaceBytes,
  );
  if (result.cancelled) {
    throwIfProcessingAborted(signal);
  }
  if (result.resourceExhausted) {
    throw new MediaProcessingError(
      "processor_unavailable",
      "Video metadata processor exhausted its resource envelope",
    );
  }
  if (result.timedOut || result.outputExceeded || result.exitCode !== 0) {
    throw new MediaProcessingError(
      "invalid_video",
      "Cannot read video metadata",
    );
  }
  try {
    return JSON.parse(result.stdout) as FfprobeResult;
  } catch {
    throw new MediaProcessingError(
      "invalid_video",
      "Cannot read video metadata",
    );
  }
}

type OutputMetadata = {
  width: number;
  height: number;
  durationSeconds: number;
};

async function probeOutputMetadata(
  path: string,
  maxAddressSpaceBytes: number,
  signal: AbortSignal,
): Promise<OutputMetadata> {
  const result = await ffprobe(path, maxAddressSpaceBytes, signal);
  const videoStream = (result.streams ?? []).find(
    (stream) => stream.codec_type === "video",
  );
  const duration = parseDuration(result);
  if (
    !videoStream?.width ||
    !videoStream.height ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    (result.chapters?.length ?? 0) > 0
  ) {
    throw new MediaProcessingError(
      "processing_failed",
      "Processed video metadata is invalid",
    );
  }
  return {
    width: videoStream.width,
    height: videoStream.height,
    durationSeconds: roundTo(duration, 3),
  };
}

function parseDuration(result: FfprobeResult): number {
  const fromFormat = Number(result.format?.duration);
  if (Number.isFinite(fromFormat)) {
    return fromFormat;
  }
  const videoStream = (result.streams ?? []).find(
    (stream) => stream.codec_type === "video",
  );
  return Number(videoStream?.duration);
}

function parseFrameRate(value: string | undefined): number {
  if (!value) {
    return Number.NaN;
  }
  const [numeratorText, denominatorText = "1"] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  return denominator > 0 ? numerator / denominator : Number.NaN;
}

type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
  outputExceeded: boolean;
  resourceExhausted: boolean;
};

async function runProcess(
  command: string,
  args: string[],
  timeoutMilliseconds: number,
  signal: AbortSignal,
  maxAddressSpaceBytes?: number,
): Promise<ProcessResult> {
  throwIfProcessingAborted(signal);
  const invocation =
    maxAddressSpaceBytes && process.platform === "linux"
      ? buildAddressSpaceLimitedCommand(command, args, maxAddressSpaceBytes)
      : [command, ...args];
  const proc = Bun.spawn(invocation, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let cancelled = false;
  let outputExceeded = false;
  const kill = () => proc.kill(9);
  const abort = () => {
    cancelled = true;
    kill();
  };
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMilliseconds);
  const onOutputLimit = () => {
    outputExceeded = true;
    kill();
  };

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedText(proc.stdout, PROCESS_OUTPUT_LIMIT_BYTES, onOutputLimit),
      readBoundedText(proc.stderr, PROCESS_OUTPUT_LIMIT_BYTES, onOutputLimit),
      proc.exited,
    ]);
    return {
      stdout,
      stderr,
      exitCode,
      timedOut,
      cancelled,
      outputExceeded,
      resourceExhausted: isChildResourceExhaustion(
        exitCode,
        proc.signalCode,
        stderr,
      ),
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function buildAddressSpaceLimitedCommand(
  command: string,
  args: string[],
  maximumBytes: number,
): string[] {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error(
      "Child address-space limit must be a positive safe integer",
    );
  }
  return [
    "sh",
    "-c",
    'limit="$1"; shift; echo 1000 > /proc/self/oom_score_adj || exit 125; exec prlimit --as="$limit" -- "$@"',
    "smp-child",
    String(maximumBytes),
    command,
    ...args,
  ];
}

export function isChildResourceExhaustion(
  exitCode: number,
  signalCode: NodeJS.Signals | null,
  stderr: string,
): boolean {
  if (signalCode === "SIGKILL" || exitCode === 125 || exitCode === 137) {
    return true;
  }
  return /(?:cannot allocate memory|failed to allocate|malloc of size .* failed|resource temporarily unavailable)/i.test(
    stderr,
  );
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  onLimit: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        onLimit();
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concatBytes(chunks, total));
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readBoundedOutput(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new MediaProcessingError(
      "processing_failed",
      "Processed video is missing",
    );
  }
  if (metadata.size > maximumBytes) {
    throw new MediaProcessingError(
      "limit_exceeded",
      "Processed video exceeds the byte limit",
    );
  }
  return Buffer.from(await Bun.file(path).arrayBuffer());
}

async function safeUnlink(path: string): Promise<void> {
  await unlink(path).catch(() => {
    // Best-effort cleanup; a missing temp file is already clean.
  });
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
