from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label} matched {count} times, expected exactly once")
    return text.replace(old, new)


image_path = Path("src/image.ts")
image = image_path.read_text()

image = replace_once(
    image,
    '''    const bytes = Buffer.concat(chunks, Number(outputBytes));
    const pages = info.pages ?? outputPages;
    const height = info.pageHeight ?? info.height;
    assertBudget(
      multiplyBigInt(info.width, height, pages),
      options.maxOutputPixels,
      `Output ${recipe.outputId} exceeds the pixel limit`,
    );
    await verifySanitizedOutput(
      bytes,
      info.width,
      height,
      pages,
      options.deadlineMilliseconds,
      signal,
    );''',
    '''    const bytes = Buffer.concat(chunks, Number(outputBytes));
    const expected: OutputContract = {
      width: info.width,
      height: info.pageHeight ?? info.height,
      pages: info.pages ?? 1,
    };
    if (
      !Number.isInteger(expected.pages) ||
      expected.pages < 1 ||
      expected.pages > outputPages
    ) {
      throw new MediaProcessingError(
        "processing_failed",
        "Image encoder reported an invalid output page count",
      );
    }
    const verified = await verifySanitizedOutput(
      bytes,
      expected,
      options.deadlineMilliseconds,
      signal,
    );
    assertBudget(
      multiplyBigInt(verified.width, verified.height, verified.pages),
      options.maxOutputPixels,
      `Output ${recipe.outputId} exceeds the pixel limit`,
    );''',
    "render output block",
)

image = replace_once(
    image,
    '''        width: info.width,
        height,
        animated: pages > 1,
        pages,''',
    '''        width: verified.width,
        height: verified.height,
        animated: verified.pages > 1,
        pages: verified.pages,''',
    "output manifest block",
)

image = replace_once(
    image,
    '''async function verifySanitizedOutput(
  bytes: Buffer,
  width: number,
  height: number,
  pages: number,
  deadlineMilliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (detectMediaKind(bytes) !== "image") {
    throw new MediaProcessingError(
      "processing_failed",
      "Encoder output magic is invalid",
    );
  }
  const verifier = sharp(bytes, { animated: true, pages: -1 }).timeout({
    seconds: Math.ceil(deadlineMilliseconds / 1000),
  });
  const abort = () => verifier.destroy(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  let metadata: SharpMetadata;
  try {
    metadata = await verifier.metadata();
  } catch {
    throwIfProcessingAborted(signal);
    throw new MediaProcessingError(
      "processing_failed",
      "Encoder output cannot be verified",
    );
  } finally {
    signal.removeEventListener("abort", abort);
    verifier.destroy();
  }
  if (
    metadata.format !== "webp" ||
    metadata.width !== width ||
    sourceFrameHeight(metadata, metadata.pages ?? 1) !== height ||
    (metadata.pages ?? 1) !== pages ||
    metadata.exif !== undefined ||
    metadata.icc !== undefined ||
    metadata.xmp !== undefined ||
    metadata.iptc !== undefined
  ) {
    throw new MediaProcessingError(
      "processing_failed",
      "Encoder output contract verification failed",
    );
  }
}''',
    '''type OutputContract = {
  width: number;
  height: number;
  pages: number;
};

async function verifySanitizedOutput(
  bytes: Buffer,
  expected: OutputContract,
  deadlineMilliseconds: number,
  signal: AbortSignal,
): Promise<OutputContract> {
  if (detectMediaKind(bytes) !== "image") {
    throw new MediaProcessingError(
      "processing_failed",
      "Encoder output magic is invalid",
    );
  }
  const verifier = sharp(bytes, { animated: true, pages: -1 }).timeout({
    seconds: Math.ceil(deadlineMilliseconds / 1000),
  });
  const abort = () => verifier.destroy(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  let metadata: SharpMetadata;
  try {
    metadata = await verifier.metadata();
  } catch {
    throwIfProcessingAborted(signal);
    throw new MediaProcessingError(
      "processing_failed",
      "Encoder output cannot be verified",
    );
  } finally {
    signal.removeEventListener("abort", abort);
    verifier.destroy();
  }

  const actual: OutputContract = {
    width: metadata.width ?? 0,
    height: sourceFrameHeight(metadata, metadata.pages ?? 1),
    pages: metadata.pages ?? 1,
  };
  if (
    metadata.format !== "webp" ||
    actual.width !== expected.width ||
    actual.height !== expected.height ||
    actual.pages !== expected.pages ||
    metadata.exif !== undefined ||
    metadata.icc !== undefined ||
    metadata.xmp !== undefined ||
    metadata.iptc !== undefined
  ) {
    throw new MediaProcessingError(
      "processing_failed",
      "Encoder output contract verification failed",
    );
  }
  return actual;
}''',
    "output verification function",
)

image_path.write_text(image)

Path("src/image.animation-regression.test.ts").write_text('''import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  IMAGE_DEFAULTS,
  processImageRecipe,
  type ImageProcessingOptions,
} from "./image";
import {
  MAX_IMAGE_RECIPE_BYTES,
  MAX_IMAGE_RECIPE_DIMENSION,
  MAX_IMAGE_RECIPE_OUTPUTS,
  parseImageRecipe,
} from "./recipe";

const FRAME_WIDTH = 200;
const FRAME_HEIGHT = 200;
const FRAME_COUNT = 86;
const FRAME_DELAY_MS = 40;
const OUTPUT_COUNT = 4;
const ANIMATION_PIXELS = FRAME_WIDTH * FRAME_HEIGHT * FRAME_COUNT;

const options: ImageProcessingOptions = {
  ...IMAGE_DEFAULTS,
  maxInputBytes: 16 * 1024 * 1024,
  maxInputPixels: ANIMATION_PIXELS,
  maxDecodedBytes: ANIMATION_PIXELS * 4,
  maxPages: FRAME_COUNT,
  maxAnimationDurationMilliseconds: FRAME_COUNT * FRAME_DELAY_MS,
  maxOutputBytes: 16 * 1024 * 1024,
  maxAggregateOutputBytes: 64 * 1024 * 1024,
  maxOutputPixels: ANIMATION_PIXELS,
  maxAggregateOutputPixels: ANIMATION_PIXELS * OUTPUT_COUNT,
  maxConcurrentEncoders: 2,
  deadlineMilliseconds: 30_000,
};

async function solidFrame(colour: string): Promise<Buffer> {
  return sharp({
    create: {
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      channels: 4,
      background: colour,
    },
  })
    .png()
    .toBuffer();
}

async function largeAnimatedGif(): Promise<Buffer> {
  const first = await solidFrame("#336699ff");
  const second = await solidFrame("#cc6633ff");
  const frames = Array.from({ length: FRAME_COUNT }, (_, index) =>
    index % 2 === 0 ? first : second,
  );

  return encodeGif(frames);
}

async function duplicateFrameGif(): Promise<Buffer> {
  const frame = await solidFrame("#336699ff");
  return encodeGif(Array(FRAME_COUNT).fill(frame), true);
}

function encodeGif(frames: Buffer[], keepDuplicateFrames = false) {
  return sharp(frames, { join: { animated: true } })
    .gif({
      delay: Array(FRAME_COUNT).fill(FRAME_DELAY_MS),
      loop: 0,
      keepDuplicateFrames,
    })
    .toBuffer();
}

function preserveRecipe() {
  return parseImageRecipe(
    JSON.stringify({
      schema_version: 1,
      animation_policy: "preserve",
      outputs: Object.fromEntries(
        [320, 640, 1280, 1920].map((width) => [
          `w${width}`,
          {
            format: "webp",
            resize: {
              mode: "inside",
              width,
              allow_upscale: false,
            },
            quality: 85,
            effort: 4,
          },
        ]),
      ),
    }),
    {
      maxRecipeBytes: MAX_IMAGE_RECIPE_BYTES,
      maxOutputs: MAX_IMAGE_RECIPE_OUTPUTS,
      maxDimension: MAX_IMAGE_RECIPE_DIMENSION,
    },
  );
}

async function expectPreservedOutputs(
  input: Buffer,
  expectedOutputPages = FRAME_COUNT,
): Promise<void> {
  const sourceMetadata = await sharp(input, {
    animated: true,
    pages: -1,
  }).metadata();
  expect(sourceMetadata.pages).toBe(FRAME_COUNT);
  expect(sourceMetadata.pageHeight).toBe(FRAME_HEIGHT);

  const processed = await processImageRecipe(input, preserveRecipe(), options);
  expect(processed.outputs).toHaveLength(OUTPUT_COUNT);

  for (const output of processed.outputs) {
    const metadata = await sharp(output.bytes, {
      animated: true,
      pages: -1,
    }).metadata();
    const pages = metadata.pages ?? 1;
    const frameHeight = metadata.pageHeight ?? metadata.height;

    expect(output.manifest).toMatchObject({
      animated: expectedOutputPages > 1,
      pages: expectedOutputPages,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
    });
    expect(pages).toBe(expectedOutputPages);
    expect(frameHeight).toBe(FRAME_HEIGHT);
    expect(metadata.height).toBe(FRAME_HEIGHT * expectedOutputPages);
    if (expectedOutputPages > 1) {
      expect(metadata.delay).toEqual(
        Array(FRAME_COUNT).fill(FRAME_DELAY_MS),
      );
      expect(metadata.loop).toBe(0);
    } else {
      expect(metadata.delay).toBeUndefined();
      expect(metadata.loop).toBeUndefined();
    }
  }
}

describe("large animated image regression", () => {
  test("renders four responsive variants above the raw stacked-height boundary", async () => {
    await expectPreservedOutputs(await largeAnimatedGif());
  });

  test("reports encoder-coalesced duplicate frames as a static output", async () => {
    const input = await duplicateFrameGif();
    const direct = await sharp(input, { animated: true, pages: -1 })
      .webp({ quality: 85, effort: 4 })
      .toBuffer();
    const directMetadata = await sharp(direct, {
      animated: true,
      pages: -1,
    }).metadata();

    expect(directMetadata).toMatchObject({
      format: "webp",
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
    });
    expect(directMetadata.pages ?? 1).toBe(1);
    await expectPreservedOutputs(input, 1);
  });
});
''')
