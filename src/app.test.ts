import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { createApp, type ProcessorDependencies } from "./app";
import { BUILD_FINGERPRINT } from "./build-info";
import { canonicalJson, contentDigest } from "./canonical-json";
import type { ProcessorConfig } from "./config";
import { IMAGE_DEFAULTS, type ProcessedImageRecipe } from "./image";
import type { ImageRecipe } from "./recipe";
import { VIDEO_DEFAULTS } from "./video";

const config: ProcessorConfig = {
  port: 6701,
  serverIdleTimeoutSeconds: 15,
  concurrency: 2,
  encoderConcurrency: 2,
  requestIdleMilliseconds: 1000,
  recipeLimits: { maxRecipeBytes: 4096, maxOutputs: 4, maxDimension: 2048 },
  image: {
    ...IMAGE_DEFAULTS,
    maxInputBytes: 1024 * 1024,
    maxInputPixels: 1_000_000,
    maxDecodedBytes: 4_000_000,
    maxPages: 10,
    maxOutputBytes: 1024 * 1024,
    maxAggregateOutputBytes: 2 * 1024 * 1024,
    maxOutputPixels: 1_000_000,
    maxAggregateOutputPixels: 2_000_000,
    deadlineMilliseconds: 10_000,
  },
  video: {
    ...VIDEO_DEFAULTS,
    maxInputBytes: 1024 * 1024,
    maxOutputBytes: 1024 * 1024,
    maxDurationSeconds: 10,
    deadlineMilliseconds: 10_000,
    crf: 30,
    preset: "ultrafast",
    audioBitrateKbps: 96,
  },
  maxImageRequestBytes: 2 * 1024 * 1024,
  maxVideoRequestBytes: 2 * 1024 * 1024,
};

async function imageFixture(): Promise<Buffer> {
  return sharp({
    create: { width: 800, height: 600, channels: 3, background: "#557799" },
  })
    .jpeg()
    .toBuffer();
}

function recipe(widths = [320, 640]): string {
  return JSON.stringify({
    schema_version: 1,
    animation_policy: "reject",
    outputs: Object.fromEntries(
      widths.map((width, index) => [
        ["small", "medium", "large", "xlarge"][index],
        {
          format: "webp",
          resize: { mode: "inside", width, allow_upscale: false },
          quality: 85,
          effort: 0,
        },
      ]),
    ),
  });
}

function imageRequest(file: Buffer, recipeText = recipe()): Request {
  return multipartRequest("/v1/images/process", [
    {
      name: "file",
      filename: "input.jpg",
      contentType: "image/jpeg",
      bytes: file,
    },
    {
      name: "recipe",
      contentType: "application/json",
      bytes: Buffer.from(recipeText),
    },
  ]);
}

function videoRequest(file: Buffer): Request {
  return multipartRequest("/v1/videos/process", [
    {
      name: "file",
      filename: "input.mp4",
      contentType: "video/mp4",
      bytes: file,
    },
  ]);
}

type RequestPart = {
  name: string;
  filename?: string;
  contentType: string;
  bytes: Buffer;
};

function multipartRequest(path: string, parts: RequestPart[]): Request {
  const boundary = "smp-test-boundary";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition =
      `Content-Disposition: form-data; name="${part.name}"` +
      (part.filename ? `; filename="${part.filename}"` : "");
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n${disposition}\r\nContent-Type: ${part.contentType}\r\n\r\n`,
      ),
      part.bytes,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return new Request(`http://processor.test${path}`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(chunks),
  });
}

type DecodedPart = { headers: Map<string, string>; bytes: Buffer };

async function decodeRelated(response: Response): Promise<DecodedPart[]> {
  const contentType = response.headers.get("content-type") ?? "";
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (!boundary) throw new Error("Missing multipart boundary");
  const body = Buffer.from(await response.arrayBuffer());
  const marker = Buffer.from(`--${boundary}`);
  const parts: DecodedPart[] = [];
  let cursor = 0;
  while (true) {
    expect(body.subarray(cursor, cursor + marker.length).equals(marker)).toBe(
      true,
    );
    cursor += marker.length;
    if (body.subarray(cursor, cursor + 2).toString("ascii") === "--") break;
    cursor += 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), cursor);
    const headers = new Map<string, string>();
    for (const line of body
      .subarray(cursor, headerEnd)
      .toString("ascii")
      .split("\r\n")) {
      const separator = line.indexOf(":");
      headers.set(
        line.slice(0, separator).toLowerCase(),
        line.slice(separator + 1).trim(),
      );
    }
    cursor = headerEnd + 4;
    const length = Number(headers.get("content-length"));
    const bytes = body.subarray(cursor, cursor + length);
    parts.push({ headers, bytes });
    cursor += length + 2;
  }
  expect(cursor + 4).toBe(body.length);
  return parts;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("v1 HTTP contract", () => {
  test("keeps app construction separate from listening and exposes build identity", async () => {
    const response = await createApp(config).handle(
      new Request("http://processor.test/health"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "smol-media-processor",
      schema_version: 1,
      build_fingerprint: BUILD_FINGERPRINT,
      ffmpeg_address_space_limit_bytes:
        VIDEO_DEFAULTS.maxChildAddressSpaceBytes,
    });
  });

  test("removes the legacy generic endpoint", async () => {
    const response = await createApp(config).handle(
      new Request("http://processor.test/process", { method: "POST" }),
    );
    expect(response.status).toBe(404);
  });

  test("returns canonical manifest-first multipart with exact digest bindings", async () => {
    const response = await createApp(config).handle(
      imageRequest(await imageFixture()),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const parts = await decodeRelated(response);
    expect(parts).toHaveLength(3);
    expect(parts[0]!.headers.get("content-id")).toBe("<manifest>");
    expect(parts[0]!.headers.get("content-digest")).toBe(
      contentDigest(parts[0]!.bytes),
    );
    const manifest = JSON.parse(parts[0]!.bytes.toString("utf8")) as {
      outputs: Record<
        string,
        { width: number; byte_length: number; digest: { value: string } }
      >;
    };
    expect(parts[0]!.bytes.toString("utf8")).toBe(canonicalJson(manifest));
    expect(Object.keys(manifest.outputs)).toEqual(["medium", "small"]);

    for (const [index, [outputId, output]] of Object.entries(
      manifest.outputs,
    ).entries()) {
      const part = parts[index + 1]!;
      expect(part.headers.get("content-id")).toBe(`<output-${outputId}>`);
      expect(part.headers.get("content-digest")).toBe(
        contentDigest(part.bytes),
      );
      expect(part.bytes.length).toBe(output.byte_length);
      expect(digest(part.bytes)).toBe(output.digest.value);
      expect((await sharp(part.bytes).metadata()).width).toBe(output.width);
    }
  });

  test("requires application/json for recipe and returns typed non-partial failures", async () => {
    const wrongMime = multipartRequest("/v1/images/process", [
      {
        name: "file",
        filename: "input.jpg",
        contentType: "image/jpeg",
        bytes: await imageFixture(),
      },
      {
        name: "recipe",
        contentType: "text/plain",
        bytes: Buffer.from(recipe()),
      },
    ]);
    const invalid = await createApp(config).handle(wrongMime);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      code: "invalid_request",
      status: 400,
    });

    const aggregateFailure = await createApp({
      ...config,
      image: { ...config.image, maxAggregateOutputBytes: 1 },
    }).handle(imageRequest(await imageFixture()));
    expect(aggregateFailure.status).toBe(413);
    expect(aggregateFailure.headers.get("content-type")).not.toContain(
      "multipart/related",
    );
    expect(await aggregateFailure.json()).toMatchObject({
      code: "limit_exceeded",
      status: 413,
    });
  });

  test("enforces max-1, max, and max+1 logical file bytes", async () => {
    const base = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "#000" },
    })
      .png()
      .toBuffer();
    const exactLimit = base.length + 1;
    const dependencies = mockDependencies();
    const app = createApp(
      { ...config, image: { ...config.image, maxInputBytes: exactLimit } },
      dependencies,
    );

    const below = await app.handle(imageRequest(base));
    expect(below.status).toBe(200);
    await below.arrayBuffer();
    const exact = await app.handle(
      imageRequest(Buffer.concat([base, Buffer.alloc(1)])),
    );
    expect(exact.status).toBe(200);
    await exact.arrayBuffer();
    const over = await app.handle(
      imageRequest(Buffer.concat([base, Buffer.alloc(2)])),
    );
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({ code: "limit_exceeded" });
  });

  test("keeps video processing on an explicit versioned endpoint", async () => {
    const videoBytes = Buffer.concat([
      Buffer.alloc(4),
      Buffer.from("ftypisom"),
    ]);
    const output = Buffer.from("sanitized-video");
    const dependencies: ProcessorDependencies = {
      async processImage() {
        throw new Error("not used");
      },
      async processVideo() {
        return {
          kind: "video",
          bytes: output,
          mimeType: "video/mp4",
          extension: "mp4",
          width: 320,
          height: 240,
          size: output.length,
          durationSeconds: 1.25,
          hasAudio: true,
        };
      },
    };
    const response = await createApp(config, dependencies).handle(
      videoRequest(videoBytes),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("x-smp-duration-seconds")).toBe("1.25");
    await response.arrayBuffer();
  });

  test("holds image admission until response EOF or cancellation", async () => {
    const app = createApp({ ...config, concurrency: 1 }, mockDependencies());
    const file = await imageFixture();
    const first = await app.handle(imageRequest(file, recipe([320])));
    expect(first.status).toBe(200);

    const whilePending = await app.handle(imageRequest(file, recipe([320])));
    expect(whilePending.status).toBe(503);
    expect(await whilePending.json()).toMatchObject({
      code: "processor_overloaded",
    });

    await first.body!.cancel();
    const afterCancel = await app.handle(imageRequest(file, recipe([320])));
    expect(afterCancel.status).toBe(200);
    await afterCancel.arrayBuffer();
  });

  test("aborts a stalled response at the whole-job deadline before releasing admission", async () => {
    const app = createApp(
      {
        ...config,
        concurrency: 1,
        image: { ...config.image, deadlineMilliseconds: 20 },
      },
      mockDependencies(),
    );
    const file = await imageFixture();
    const stalled = await app.handle(imageRequest(file, recipe([320])));
    expect(stalled.status).toBe(200);
    await Bun.sleep(30);
    let deliveryFailure: unknown;
    try {
      await stalled.arrayBuffer();
    } catch (error) {
      deliveryFailure = error;
    }
    expect(deliveryFailure).toMatchObject({
      code: "processor_unavailable",
    });

    const recovered = await app.handle(imageRequest(file, recipe([320])));
    expect(recovered.status).toBe(200);
    await recovered.arrayBuffer();
  });

  test("gives a video the full admission capacity until its body completes", async () => {
    const output = Buffer.from("sanitized-video");
    const dependencies: ProcessorDependencies = {
      ...mockDependencies(),
      async processVideo() {
        return {
          kind: "video",
          bytes: output,
          mimeType: "video/mp4",
          extension: "mp4",
          width: 320,
          height: 240,
          size: output.length,
          durationSeconds: 1,
          hasAudio: false,
        };
      },
    };
    const app = createApp({ ...config, concurrency: 2 }, dependencies);
    const videoBytes = Buffer.concat([
      Buffer.alloc(4),
      Buffer.from("ftypisom"),
    ]);
    const video = await app.handle(videoRequest(videoBytes));
    expect(video.status).toBe(200);

    const whileVideoPending = await app.handle(
      imageRequest(await imageFixture(), recipe([320])),
    );
    expect(whileVideoPending.status).toBe(503);
    expect(await whileVideoPending.json()).toMatchObject({
      code: "processor_overloaded",
    });

    await video.body!.cancel();
    const afterCancel = await app.handle(
      imageRequest(await imageFixture(), recipe([320])),
    );
    expect(afterCancel.status).toBe(200);
    await afterCancel.arrayBuffer();
  });

  test("applies admission before parsing and one deadline across the job", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => (started = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const dependencies = mockDependencies(async (input, parsedRecipe) => {
      started();
      await blocked;
      return mockProcessed(input, parsedRecipe);
    });
    const app = createApp({ ...config, concurrency: 1 }, dependencies);
    const first = app.handle(imageRequest(await imageFixture(), recipe([320])));
    await entered;
    const second = await app.handle(
      new Request("http://processor.test/v1/images/process", {
        method: "POST",
        body: "not multipart",
      }),
    );
    expect(second.status).toBe(503);
    expect(await second.json()).toMatchObject({ code: "processor_overloaded" });
    release();
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    await firstResponse.arrayBuffer();

    const deadlineDependencies = mockDependencies(
      async (_input, _recipe, _options, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          });
        });
        throw new Error("unreachable");
      },
    );
    const timedOut = await createApp(
      {
        ...config,
        image: { ...config.image, deadlineMilliseconds: 20 },
      },
      deadlineDependencies,
    ).handle(imageRequest(await imageFixture(), recipe([320])));
    expect(timedOut.status).toBe(503);
    expect(await timedOut.json()).toMatchObject({
      code: "processor_unavailable",
    });
  });
});

function mockDependencies(
  processImage: ProcessorDependencies["processImage"] = async (
    input,
    parsedRecipe,
  ) => mockProcessed(input, parsedRecipe),
): ProcessorDependencies {
  return {
    processImage,
    async processVideo() {
      throw new Error("not used");
    },
  };
}

function mockProcessed(
  input: Buffer,
  parsedRecipe: ImageRecipe,
): ProcessedImageRecipe {
  const bytes = Buffer.from("RIFFmockWEBP");
  const outputId = parsedRecipe.outputs[0]!.outputId;
  const manifest = {
    mime_type: "image/webp" as const,
    extension: "webp" as const,
    byte_length: bytes.length,
    width: 1,
    height: 1,
    animated: false,
    pages: 1,
    digest: { algorithm: "sha-256" as const, value: digest(bytes) },
  };
  return {
    manifest: {
      schema_version: 1,
      kind: "image",
      input_digest: { algorithm: "sha-256", value: digest(input) },
      recipe_digest: parsedRecipe.digest,
      build_fingerprint: BUILD_FINGERPRINT,
      source: {
        format: "png",
        width: 1,
        height: 1,
        animated: false,
        pages: 1,
        orientation: null,
        metadata: { extraction_version: 1, fields: [] },
      },
      outputs: { [outputId]: manifest },
    },
    outputs: [{ outputId, filename: `${outputId}.webp`, bytes, manifest }],
  };
}
