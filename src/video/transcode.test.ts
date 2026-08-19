import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAddressSpaceLimitedCommand,
  buildVideoTranscodeArgs,
  estimateVideoDecoderWorkingSetBytes,
  isChildResourceExhaustion,
  processVideo,
  resolveVideoDecodeDimensions,
  VIDEO_DEFAULTS,
  type VideoOptions,
} from "./transcode";

const options: VideoOptions = {
  maxInputBytes: 50 * 1024 * 1024,
  maxOutputBytes: 50 * 1024 * 1024,
  maxDurationSeconds: 10,
  maxInputDimension: 2048,
  maxFrameRate: 30,
  maxDecodePixels: 1_000_000_000,
  maxDecoderWorkingSetBytes: 192 * 1024 * 1024,
  maxChildAddressSpaceBytes: 768 * 1024 * 1024,
  maxDimension: 1920,
  deadlineMilliseconds: 60_000,
  crf: 30,
  preset: "ultrafast",
  audioBitrateKbps: 96,
};

type CreateVideoOptions = {
  duration?: number;
  width?: number;
  height?: number;
  audio?: boolean;
  container?: "mp4" | "avi";
  title?: string;
  chapterTitle?: string;
  frameRate?: number;
};

function createTestVideo(opts: CreateVideoOptions = {}): Buffer {
  const {
    duration = 1,
    width = 320,
    height = 240,
    audio = true,
    container = "mp4",
    title,
    chapterTitle,
    frameRate = 15,
  } = opts;

  const out = join(tmpdir(), `smp-test-${randomUUID()}.${container}`);
  const metadataPath = join(tmpdir(), `smp-test-${randomUUID()}.ffmeta`);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=duration=${duration}:size=${width}x${height}:rate=${frameRate}`,
    ...(audio
      ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`]
      : []),
  ];

  if (container === "mp4") {
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      ...(audio ? ["-c:a", "aac"] : []),
    );
  } else {
    args.push("-c:v", "mpeg4", ...(audio ? ["-c:a", "mp3"] : []));
  }

  if (title) {
    args.push("-metadata", `title=${title}`);
  }

  if (chapterTitle) {
    writeFileSync(
      metadataPath,
      `;FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=500\ntitle=${chapterTitle}\n`,
    );
    const metadataIndex = audio ? 2 : 1;
    args.splice(audio ? 12 : 8, 0, "-f", "ffmetadata", "-i", metadataPath);
    args.push("-map_chapters", String(metadataIndex));
  }

  args.push(out);

  const result = Bun.spawnSync({
    cmd: ["ffmpeg", ...args],
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }

  const buffer = readFileSync(out);
  unlinkSync(out);
  if (chapterTitle) unlinkSync(metadataPath);
  return buffer;
}

function probe(buffer: Buffer): {
  format?: { format_name?: string; tags?: Record<string, string> };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    tags?: Record<string, string>;
  }>;
  chapters?: Array<{ tags?: Record<string, string> }>;
} {
  const path = join(tmpdir(), `smp-probe-${randomUUID()}.bin`);
  writeFileSync(path, buffer);
  try {
    const result = Bun.spawnSync({
      cmd: [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-show_chapters",
        path,
      ],
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr?.toString() ?? "ffprobe failed");
    }
    return JSON.parse(result.stdout.toString());
  } finally {
    unlinkSync(path);
  }
}

describe("processVideo", () => {
  test("runs ffmpeg and ffprobe under the selected child address-space fence", () => {
    expect(
      buildAddressSpaceLimitedCommand(
        "ffmpeg",
        ["-i", "input.mp4"],
        options.maxChildAddressSpaceBytes,
      ),
    ).toEqual([
      "sh",
      "-c",
      'limit="$1"; shift; echo 1000 > /proc/self/oom_score_adj || exit 125; exec prlimit --as="$limit" -- "$@"',
      "smp-child",
      String(options.maxChildAddressSpaceBytes),
      "ffmpeg",
      "-i",
      "input.mp4",
    ]);
  });

  test("classifies child OOM and address-space exhaustion as unavailable", () => {
    expect(isChildResourceExhaustion(137, null, "")).toBe(true);
    expect(isChildResourceExhaustion(1, "SIGKILL", "")).toBe(true);
    expect(
      isChildResourceExhaustion(
        1,
        null,
        "x264 [error]: malloc of size 7332480 failed",
      ),
    ).toBe(true);
    expect(isChildResourceExhaustion(1, null, "Invalid data found")).toBe(
      false,
    );
  });

  test("uses coded dimensions when they exceed display dimensions", () => {
    expect(
      resolveVideoDecodeDimensions({
        width: 1280,
        height: 720,
        coded_width: 4096,
        coded_height: 2160,
      }),
    ).toEqual({ width: 4096, height: 2160 });
  });

  test("pins decoder and encoder thread ceilings in their ffmpeg scopes", () => {
    const args = buildVideoTranscodeArgs(
      "input.mp4",
      "output.mp4",
      true,
      options,
    );
    const inputIndex = args.indexOf("-i");
    const codecIndex = args.indexOf("-c:v");
    const threadIndexes = args
      .map((value, index) => (value === "-threads:v:0" ? index : -1))
      .filter((index) => index >= 0);

    expect(threadIndexes).toHaveLength(2);
    expect(threadIndexes[0]!).toBeLessThan(inputIndex);
    expect(threadIndexes[1]!).toBeGreaterThan(codecIndex);
    expect(args[threadIndexes[0]! + 1]).toBe("2");
    expect(args[threadIndexes[1]! + 1]).toBe("2");
  });

  test("transcodes MP4 with audio to sanitized MP4", async () => {
    const input = createTestVideo({ width: 320, height: 240, audio: true });

    const output = await processVideo(input, options);
    const meta = probe(output.bytes);

    expect(output.kind).toBe("video");
    expect(output.mimeType).toBe("video/mp4");
    expect(output.extension).toBe("mp4");
    expect(output.width).toBe(320);
    expect(output.height).toBe(240);
    expect(output.size).toBe(output.bytes.length);
    expect(output.hasAudio).toBe(true);
    expect(output.durationSeconds).toBeGreaterThan(0);

    const videoStream = meta.streams?.find((s) => s.codec_type === "video");
    const audioStream = meta.streams?.find((s) => s.codec_type === "audio");
    expect(videoStream?.codec_name).toBe("h264");
    expect(audioStream?.codec_name).toBe("aac");
  });

  test("reports hasAudio=false for silent video", async () => {
    const input = createTestVideo({ audio: false });

    const output = await processVideo(input, options);
    const meta = probe(output.bytes);

    expect(output.hasAudio).toBe(false);
    expect(meta.streams?.some((s) => s.codec_type === "audio")).toBe(false);
  });

  test("downscales videos that exceed maxDimension and keeps even dimensions", async () => {
    const input = createTestVideo({ width: 640, height: 480, audio: false });

    const output = await processVideo(input, { ...options, maxDimension: 320 });

    expect(output.width).toBeLessThanOrEqual(320);
    expect(output.height).toBeLessThanOrEqual(320);
    expect(output.width % 2).toBe(0);
    expect(output.height % 2).toBe(0);
  });

  test("transcodes non-MP4 (AVI) input to MP4", async () => {
    const input = createTestVideo({ container: "avi", audio: false });

    const output = await processVideo(input, options);

    expect(output.mimeType).toBe("video/mp4");
    expect(output.width).toBe(320);
    expect(output.height).toBe(240);
  });

  test("strips source, stream, and chapter metadata", async () => {
    const input = createTestVideo({
      audio: false,
      title: "TopSecretTitle",
      chapterTitle: "TopSecretChapter",
    });
    expect(probe(input).format?.tags?.title).toBe("TopSecretTitle");
    expect(probe(input).chapters?.[0]?.tags?.title).toBe("TopSecretChapter");

    const output = await processVideo(input, options);
    const meta = probe(output.bytes);

    expect(meta.format?.tags?.title).toBeUndefined();
    expect(meta.chapters).toEqual([]);
    expect(
      meta.streams?.some((stream) =>
        Object.values(stream.tags ?? {}).some((value) =>
          value.includes("TopSecret"),
        ),
      ),
    ).toBe(false);
  });

  test("rejects empty input", async () => {
    await expect(processVideo(Buffer.alloc(0), options)).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects inputs that exceed the max input size", async () => {
    await expect(
      processVideo(Buffer.alloc(options.maxInputBytes + 1), options),
    ).rejects.toMatchObject({
      status: 413,
      code: "limit_exceeded",
    });
  });

  test("rejects videos longer than the duration limit", async () => {
    const input = createTestVideo({ duration: 2, audio: false });

    await expect(
      processVideo(input, { ...options, maxDurationSeconds: 1 }),
    ).rejects.toMatchObject({
      status: 413,
      code: "limit_exceeded",
    });
  });

  test("rejects input dimension, frame-rate, and decode-pixel amplification", async () => {
    const input = createTestVideo({
      width: 640,
      height: 480,
      frameRate: 15,
      audio: false,
    });
    await expect(
      processVideo(input, { ...options, maxInputDimension: 639 }),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
    await expect(
      processVideo(input, { ...options, maxFrameRate: 14 }),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
    await expect(
      processVideo(input, { ...options, maxDecodePixels: 1 }),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
    const exactWorkingSet = Number(
      estimateVideoDecoderWorkingSetBytes({
        width: 640,
        height: 480,
        codecName: "h264",
        pixelFormat: "yuv420p",
        bitsPerRawSample: "8",
      }),
    );
    await expect(
      processVideo(input, {
        ...options,
        maxDecoderWorkingSetBytes: exactWorkingSet,
      }),
    ).resolves.toBeDefined();
    await expect(
      processVideo(input, {
        ...options,
        maxDecoderWorkingSetBytes: exactWorkingSet - 1,
      }),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
  });

  test("rejects high-bit-depth and unsafe decoded working sets before transcode", () => {
    expect(() =>
      estimateVideoDecoderWorkingSetBytes({
        width: 1920,
        height: 1080,
        codecName: "hevc",
        pixelFormat: "yuv420p10le",
        bitsPerRawSample: "10",
      }),
    ).toThrow("Unsupported video pixel format");
    const eightK = estimateVideoDecoderWorkingSetBytes({
      width: 8192,
      height: 8192,
      codecName: "h264",
      pixelFormat: "yuv420p",
      bitsPerRawSample: "8",
    });
    expect(eightK).toBeGreaterThan(
      BigInt(VIDEO_DEFAULTS.maxDecoderWorkingSetBytes),
    );
  });

  test("rejects oversized output", async () => {
    const input = createTestVideo({ audio: false });

    const baseline = await processVideo(input, options);
    await expect(
      processVideo(input, {
        ...options,
        maxOutputBytes: baseline.bytes.length,
      }),
    ).resolves.toBeDefined();

    await expect(
      processVideo(input, {
        ...options,
        maxOutputBytes: baseline.bytes.length - 1,
      }),
    ).rejects.toMatchObject({
      status: 413,
      code: "limit_exceeded",
    });
  });

  test("rejects invalid video bytes", async () => {
    await expect(
      processVideo(Buffer.from("not-a-video"), options),
    ).rejects.toMatchObject({
      status: 422,
      code: "invalid_video",
    });
  });

  test("honors cancellation before creating temp files", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      processVideo(Buffer.from("input"), options, controller.signal),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });

  test("kills an in-flight transcode and removes its temporary files", async () => {
    const before = temporaryMediaFiles();
    const controller = new AbortController();
    const pending = processVideo(
      createTestVideo({ duration: 3, width: 1280, height: 720, audio: false }),
      options,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
    });
    expect(temporaryMediaFiles()).toEqual(before);
  });
});

function temporaryMediaFiles(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("smp-") && !name.startsWith("smp-test-"))
    .sort();
}
