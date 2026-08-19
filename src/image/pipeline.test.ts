import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  IMAGE_DEFAULTS,
  processImageRecipe,
  type ImageProcessingInstrumentation,
  type ImageProcessingOptions,
} from "./pipeline";
import {
  MAX_IMAGE_RECIPE_BYTES,
  MAX_IMAGE_RECIPE_DIMENSION,
  MAX_IMAGE_RECIPE_OUTPUTS,
  parseImageRecipe,
  type AnimationPolicy,
  type ImageRecipe,
} from "./recipe";

const options: ImageProcessingOptions = {
  ...IMAGE_DEFAULTS,
  maxInputBytes: 1024 * 1024,
  maxInputPixels: 1_000_000,
  maxDecodedBytes: 4_000_000,
  maxPages: 10,
  maxAnimationDurationMilliseconds: 10_000,
  maxOutputBytes: 1024 * 1024,
  maxAggregateOutputBytes: 2 * 1024 * 1024,
  maxOutputPixels: 1_000_000,
  maxAggregateOutputPixels: 2_000_000,
  maxConcurrentEncoders: 2,
  deadlineMilliseconds: 10_000,
};

type WireOutput = {
  format: "webp";
  resize:
    | {
        mode: "inside";
        width: number;
        allow_upscale: false;
      }
    | {
        mode: "cover";
        width: number;
        height: number;
        allow_upscale: false;
      };
  quality: number;
  effort: number;
};

function recipe(
  outputs: Array<[string, WireOutput]>,
  animationPolicy: AnimationPolicy = "reject",
): ImageRecipe {
  return parseImageRecipe(
    JSON.stringify({
      schema_version: 1,
      animation_policy: animationPolicy,
      outputs: Object.fromEntries(outputs),
    }),
    {
      maxRecipeBytes: MAX_IMAGE_RECIPE_BYTES,
      maxOutputs: MAX_IMAGE_RECIPE_OUTPUTS,
      maxDimension: MAX_IMAGE_RECIPE_DIMENSION,
    },
  );
}

function inside(outputId: string, width: number): [string, WireOutput] {
  return [
    outputId,
    {
      format: "webp",
      resize: { mode: "inside", width, allow_upscale: false },
      quality: 85,
      effort: 0,
    },
  ];
}

function cover(
  outputId: string,
  width: number,
  height: number,
): [string, WireOutput] {
  return [
    outputId,
    {
      format: "webp",
      resize: { mode: "cover", width, height, allow_upscale: false },
      quality: 80,
      effort: 0,
    },
  ];
}

async function fixture(width = 800, height = 600): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: "#336699" },
  })
    .jpeg()
    .toBuffer();
}

async function animatedFixture(delays = [80, 120]): Promise<Buffer> {
  const first = await fixture(2, 1);
  const frames = await Promise.all(
    delays.map((_, index) =>
      index % 2 === 0
        ? Promise.resolve(first)
        : sharp(first).negate().jpeg().toBuffer(),
    ),
  );
  return sharp(frames, { join: { animated: true } })
    .gif({ delay: delays, loop: 2 })
    .toBuffer();
}

/**
 * Animated GIF whose frames follow `pattern` (e.g. "AABBA"), keeping duplicate
 * consecutive frames as distinct pages so the WebP encoder's frame merging can
 * be exercised. `size` scales the 2:1 frame canvas.
 */
async function duplicateFrameFixture(
  pattern: string,
  delays: number[],
  size = 1,
): Promise<Buffer> {
  const width = 2 * size;
  const height = 1 * size;
  const a = await fixture(width, height);
  const b = await sharp(a).negate().png().toBuffer();
  const frames = Array.from(pattern, (letter) => (letter === "A" ? a : b));
  return sharp(frames, { join: { animated: true } })
    .gif({ delay: delays, loop: 0, keepDuplicateFrames: true })
    .toBuffer();
}

async function uniqueFrameFixture(
  frames: number,
  width: number,
  height: number,
): Promise<Buffer> {
  const pages: Buffer[] = [];
  for (let index = 0; index < frames; index += 1) {
    const svg = `<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="rgb(${(index * 37) % 256},${(index * 91) % 256},${(index * 53) % 256})"/><rect x="${(index * 7) % width}" y="${(index * 11) % height}" width="8" height="8" fill="white"/></svg>`;
    pages.push(await sharp(Buffer.from(svg)).png().toBuffer());
  }
  return sharp(pages, { join: { animated: true } })
    .gif({ delay: 40, loop: 0, keepDuplicateFrames: true })
    .toBuffer();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("processImageRecipe", () => {
  test("decodes once and bounds encoder concurrency for independent outputs", async () => {
    const input = await fixture();
    let decodes = 0;
    let activeEncoders = 0;
    let maxActiveEncoders = 0;
    const instrumentation: ImageProcessingInstrumentation = {
      onDecodeStart() {
        decodes += 1;
      },
      onEncoderStart() {
        activeEncoders += 1;
        maxActiveEncoders = Math.max(maxActiveEncoders, activeEncoders);
      },
      onEncoderEnd() {
        activeEncoders -= 1;
      },
    };
    const result = await processImageRecipe(
      input,
      recipe([inside("small", 320), inside("medium", 640)]),
      options,
      undefined,
      instrumentation,
    );

    expect(decodes).toBe(1);
    expect(maxActiveEncoders).toBeLessThanOrEqual(2);
    expect(activeEncoders).toBe(0);
    expect(result.manifest.input_digest.value).toBe(sha256(input));
    expect(Object.keys(result.manifest.outputs)).toEqual(["medium", "small"]);
    expect(result.outputs.map((output) => output.manifest.width)).toEqual([
      640, 320,
    ]);

    for (const output of result.outputs) {
      const metadata = await sharp(output.bytes).metadata();
      expect(metadata.format).toBe("webp");
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(output.manifest.byte_length).toBe(output.bytes.length);
      expect(output.manifest.digest.value).toBe(sha256(output.bytes));
    }
  });

  test("rejects impossible output geometry before launching a decoder", async () => {
    let decodes = 0;
    await expect(
      processImageRecipe(
        await fixture(1100, 1100),
        recipe([cover("huge", 1100, 1100)]),
        {
          ...options,
          maxInputPixels: 2_000_000,
          maxDecodedBytes: 8_000_000,
          maxOutputPixels: 1_000_000,
        },
        undefined,
        { onDecodeStart: () => (decodes += 1) },
      ),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
    expect(decodes).toBe(0);
  });

  test("does not upscale inside or cover outputs", async () => {
    const input = await fixture(100, 50);
    const result = await processImageRecipe(
      input,
      recipe([inside("display", 640), cover("avatar", 128, 128)]),
      options,
    );
    expect(result.outputs[1]?.manifest).toMatchObject({
      width: 100,
      height: 50,
    });
    expect(result.outputs[0]!.manifest.width).toBeLessThanOrEqual(128);
    expect(result.outputs[0]!.manifest.height).toBeLessThanOrEqual(128);
  });

  test("applies orientation and exposes only bounded restricted metadata", async () => {
    const input = await sharp({
      create: { width: 3, height: 5, channels: 3, background: "#abcdef" },
    })
      .withMetadata({ orientation: 6, icc: "srgb" })
      .withExif({ IFD0: { Make: "TestCam", Model: "PrivateModel" } })
      .withXmp(
        '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>',
      )
      .jpeg()
      .toBuffer();

    const result = await processImageRecipe(
      input,
      recipe([inside("display", 100)]),
      options,
    );
    const outputMetadata = await sharp(result.outputs[0]!.bytes).metadata();

    expect(result.manifest.source.width).toBe(5);
    expect(result.manifest.source.height).toBe(3);
    expect(result.manifest.source.metadata.fields).toContainEqual({
      name: "Make",
      value: "TestCam",
      sensitivity: "restricted",
    });
    expect(outputMetadata.orientation).toBeUndefined();
    expect(outputMetadata.exif).toBeUndefined();
    expect(outputMetadata.icc).toBeUndefined();
    expect(outputMetadata.xmp).toBeUndefined();
  });

  test("normalizes GPS and user comment as restricted source metadata", async () => {
    const input = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#224466" },
    })
      .withExif({
        IFD2: { UserComment: "private note" },
        IFD3: {
          GPSLatitudeRef: "N",
          GPSLatitude: "37/1 30/1 0/1",
          GPSLongitudeRef: "E",
          GPSLongitude: "127/1 0/1 0/1",
          GPSAltitude: "123/1",
        },
      })
      .jpeg()
      .toBuffer();
    const result = await processImageRecipe(
      input,
      recipe([inside("small", 2)]),
      options,
    );

    expect(result.manifest.source.metadata.fields).toEqual(
      expect.arrayContaining([
        { name: "latitude", value: 37.5, sensitivity: "restricted" },
        { name: "longitude", value: 127, sensitivity: "restricted" },
        { name: "GPSAltitude", value: 123, sensitivity: "restricted" },
        {
          name: "userComment",
          value: "private note",
          sensitivity: "restricted",
        },
      ]),
    );
    expect(
      (await sharp(result.outputs[0]!.bytes).metadata()).exif,
    ).toBeUndefined();
  });

  test("reject, preserve, and first_frame have explicit animation semantics", async () => {
    const animated = await animatedFixture();
    await expect(
      processImageRecipe(animated, recipe([inside("display", 100)]), options),
    ).rejects.toMatchObject({ status: 422, code: "animation_not_allowed" });

    const preserved = await processImageRecipe(
      animated,
      recipe([inside("display", 100)], "preserve"),
      options,
    );
    expect(preserved.manifest.source).toMatchObject({
      animated: true,
      pages: 2,
    });
    expect(preserved.outputs[0]?.manifest).toMatchObject({
      animated: true,
      pages: 2,
    });

    const firstFrame = await processImageRecipe(
      animated,
      recipe([inside("display", 100)], "first_frame"),
      options,
    );
    expect(firstFrame.manifest.source).toMatchObject({
      animated: true,
      pages: 2,
    });
    expect(firstFrame.outputs[0]?.manifest).toMatchObject({
      animated: false,
      pages: 1,
    });
  });

  test("preserved animations report the encoded page count when identical frames merge", async () => {
    // libwebp merges consecutive identical frames into one frame with the
    // summed delay; the manifest must describe the bytes actually served.
    const merged = await duplicateFrameFixture("AABBA", [40, 60, 80, 100, 120]);
    const result = await processImageRecipe(
      merged,
      recipe([inside("display", 100)], "preserve"),
      options,
    );
    expect(result.manifest.source).toMatchObject({ animated: true, pages: 5 });
    const output = result.outputs[0]!;
    expect(output.manifest).toMatchObject({
      animated: true,
      pages: 3,
      width: 2,
      height: 1,
    });
    const encoded = await sharp(output.bytes, {
      animated: true,
      pages: -1,
    }).metadata();
    expect(encoded.pages).toBe(3);
    expect(encoded.delay).toEqual([100, 180, 120]);
    expect(encoded.loop).toBe(0);
  });

  test("preserved animations whose frames all collapse become a still WebP", async () => {
    const still = await duplicateFrameFixture("AAA", [40, 40, 40]);
    const result = await processImageRecipe(
      still,
      recipe([inside("display", 100)], "preserve"),
      options,
    );
    expect(result.manifest.source).toMatchObject({ animated: true, pages: 3 });
    expect(result.outputs[0]?.manifest).toMatchObject({
      animated: false,
      pages: 1,
      width: 2,
      height: 1,
    });
    const encoded = await sharp(result.outputs[0]!.bytes, {
      animated: true,
      pages: -1,
    }).metadata();
    expect(encoded.format).toBe("webp");
    expect(encoded.pages ?? 1).toBe(1);
  });

  test("preserved animations keep every unique frame past a 16,383px raw stack", async () => {
    // Regression for issue #24: 86 unique 200x200 frames decode to a
    // 200x17,200 raw stack; the encoded WebP must still carry all 86 pages.
    const frames = 86;
    const source = await uniqueFrameFixture(frames, 200, 200);
    const result = await processImageRecipe(
      source,
      recipe([inside("full", 200), inside("thumb", 64)], "preserve"),
      {
        ...options,
        maxPages: 100,
        maxInputPixels: 200 * 200 * frames,
        maxDecodedBytes: 200 * 200 * frames * 4,
        maxOutputPixels: 200 * 200 * frames,
        maxAggregateOutputPixels: 2 * 200 * 200 * frames,
        maxOutputBytes: 8 * 1024 * 1024,
        maxAggregateOutputBytes: 16 * 1024 * 1024,
        maxAnimationDurationMilliseconds: 40 * frames,
      },
    );
    expect(result.manifest.source).toMatchObject({
      animated: true,
      pages: frames,
      width: 200,
      height: 200,
    });
    for (const output of result.outputs) {
      expect(output.manifest).toMatchObject({ animated: true, pages: frames });
      const encoded = await sharp(output.bytes, {
        animated: true,
        pages: -1,
      }).metadata();
      expect(encoded.pages).toBe(frames);
      expect(encoded.pageHeight).toBe(output.manifest.height);
      expect(encoded.delay).toHaveLength(frames);
    }
    expect(result.outputs[0]?.manifest).toMatchObject({
      width: 200,
      height: 200,
    });
    expect(result.outputs[1]?.manifest).toMatchObject({
      width: 64,
      height: 64,
    });
  }, 60_000);

  test("enforces page and animation-duration max-1, max, and max+1 before decode", async () => {
    const onePage = await fixture(2, 1);
    const underDuration = await animatedFixture([90, 100]);
    const exactDuration = await animatedFixture([100, 100]);
    const overDuration = await animatedFixture([100, 110]);
    const threePages = await animatedFixture([60, 60, 60]);

    await expect(
      processImageRecipe(onePage, recipe([inside("display", 100)]), {
        ...options,
        maxPages: 2,
      }),
    ).resolves.toBeDefined();
    await expect(
      processImageRecipe(
        exactDuration,
        recipe([inside("display", 100)], "preserve"),
        { ...options, maxPages: 2, maxAnimationDurationMilliseconds: 200 },
      ),
    ).resolves.toBeDefined();
    await expect(
      processImageRecipe(
        threePages,
        recipe([inside("display", 100)], "preserve"),
        { ...options, maxPages: 2 },
      ),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });

    await expect(
      processImageRecipe(
        underDuration,
        recipe([inside("display", 100)], "preserve"),
        { ...options, maxAnimationDurationMilliseconds: 200 },
      ),
    ).resolves.toBeDefined();
    await expect(
      processImageRecipe(
        overDuration,
        recipe([inside("display", 100)], "preserve"),
        { ...options, maxAnimationDurationMilliseconds: 200 },
      ),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });

    let decodes = 0;
    await expect(
      processImageRecipe(
        overDuration,
        recipe([inside("display", 100)], "preserve"),
        { ...options, maxAnimationDurationMilliseconds: 200 },
        undefined,
        { onDecodeStart: () => (decodes += 1) },
      ),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
    expect(decodes).toBe(0);
  });

  test("enforces exact input and output byte boundaries", async () => {
    const input = await fixture(100, 100);
    await expect(
      processImageRecipe(input, recipe([inside("display", 100)]), {
        ...options,
        maxInputBytes: input.length,
      }),
    ).resolves.toBeDefined();
    await expect(
      processImageRecipe(input, recipe([inside("display", 100)]), {
        ...options,
        maxInputBytes: input.length - 1,
      }),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
    await expect(
      processImageRecipe(input, recipe([inside("display", 100)]), {
        ...options,
        maxOutputBytes: 1,
      }),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });

    const baseline = await processImageRecipe(
      input,
      recipe([inside("display", 100)]),
      options,
    );
    const exactOutputBytes = baseline.outputs[0]!.bytes.length;
    await expect(
      processImageRecipe(input, recipe([inside("display", 100)]), {
        ...options,
        maxOutputBytes: exactOutputBytes,
        maxAggregateOutputBytes: exactOutputBytes,
      }),
    ).resolves.toBeDefined();
    await expect(
      processImageRecipe(input, recipe([inside("display", 100)]), {
        ...options,
        maxOutputBytes: exactOutputBytes - 1,
      }),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
  });

  test("enforces decoded, per-output, and aggregate pixel boundaries", async () => {
    const input = await fixture(10, 10);
    const single = recipe([inside("single", 10)]);
    await expect(
      processImageRecipe(input, single, {
        ...options,
        maxInputPixels: 100,
        maxDecodedBytes: 400,
        maxOutputPixels: 100,
        maxAggregateOutputPixels: 100,
      }),
    ).resolves.toBeDefined();
    for (const override of [
      { maxInputPixels: 99 },
      { maxDecodedBytes: 399 },
      { maxOutputPixels: 99 },
      { maxAggregateOutputPixels: 99 },
    ]) {
      await expect(
        processImageRecipe(input, single, { ...options, ...override }),
      ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
    }
  });

  test("fails the whole recipe on per-output or aggregate byte overflow", async () => {
    const input = await fixture(800, 600);
    const small = await processImageRecipe(
      input,
      recipe([inside("small", 64)]),
      options,
    );
    const smallBytes = small.outputs[0]!.bytes.length;

    await expect(
      processImageRecipe(
        input,
        recipe([inside("small", 64), inside("large", 800)]),
        { ...options, maxOutputBytes: smallBytes },
      ),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
    const aggregateRecipe = recipe([inside("a", 100), inside("b", 100)]);
    const aggregateBaseline = await processImageRecipe(
      input,
      aggregateRecipe,
      options,
    );
    const aggregateBytes = aggregateBaseline.outputs.reduce(
      (total, output) => total + output.bytes.length,
      0,
    );
    await expect(
      processImageRecipe(input, aggregateRecipe, {
        ...options,
        maxAggregateOutputBytes: aggregateBytes + 1,
      }),
    ).resolves.toBeDefined();
    await expect(
      processImageRecipe(input, aggregateRecipe, {
        ...options,
        maxAggregateOutputBytes: aggregateBytes,
      }),
    ).resolves.toBeDefined();
    await expect(
      processImageRecipe(input, aggregateRecipe, {
        ...options,
        maxAggregateOutputBytes: aggregateBytes - 1,
      }),
    ).rejects.toMatchObject({ status: 413, code: "limit_exceeded" });
  });

  test("terminates a stalled EXIF worker at the whole-image deadline", async () => {
    const input = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "#abcdef" },
    })
      .withExif({ IFD0: { Make: "TestCam" } })
      .jpeg()
      .toBuffer();
    let terminated = false;
    class StalledWorker extends EventEmitter {
      postMessage(): void {}
      async terminate(): Promise<number> {
        terminated = true;
        return 1;
      }
    }

    await expect(
      processImageRecipe(
        input,
        recipe([inside("display", 4)]),
        { ...options, deadlineMilliseconds: 20 },
        undefined,
        { sourceMetadataWorkerFactory: () => new StalledWorker() },
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "processor_unavailable",
    });
    expect(terminated).toBe(true);
  });

  test("cancels sibling encoders when one output fails", async () => {
    const started: string[] = [];
    const ended: string[] = [];
    await expect(
      processImageRecipe(
        await fixture(800, 600),
        recipe([inside("a", 800), inside("b", 800), inside("c", 800)]),
        options,
        undefined,
        {
          onEncoderStart(outputId) {
            started.push(outputId);
            if (outputId === "b") throw new Error("injected encoder failure");
          },
          onEncoderEnd(outputId) {
            ended.push(outputId);
          },
        },
      ),
    ).rejects.toMatchObject({ status: 422, code: "processing_failed" });
    expect(ended.sort()).toEqual(started.sort());
    expect(started).not.toContain("c");
  });

  test("rejects empty, unsupported, and cancelled inputs", async () => {
    await expect(
      processImageRecipe(
        Buffer.alloc(0),
        recipe([inside("display", 100)]),
        options,
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(
      processImageRecipe(
        Buffer.from("not-an-image"),
        recipe([inside("display", 100)]),
        options,
      ),
    ).rejects.toMatchObject({ status: 415, code: "unsupported_format" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      processImageRecipe(
        await fixture(10, 10),
        recipe([inside("display", 10)]),
        options,
        controller.signal,
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });
});
