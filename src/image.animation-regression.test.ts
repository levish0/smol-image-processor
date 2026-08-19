import { describe, expect, test } from "bun:test";
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

const options: ImageProcessingOptions = {
  ...IMAGE_DEFAULTS,
  maxInputBytes: 16 * 1024 * 1024,
  maxInputPixels: FRAME_WIDTH * FRAME_HEIGHT * FRAME_COUNT,
  maxDecodedBytes: FRAME_WIDTH * FRAME_HEIGHT * FRAME_COUNT * 4,
  maxPages: FRAME_COUNT,
  maxAnimationDurationMilliseconds: FRAME_COUNT * FRAME_DELAY_MS,
  maxOutputBytes: 16 * 1024 * 1024,
  maxAggregateOutputBytes: 16 * 1024 * 1024,
  maxOutputPixels: FRAME_WIDTH * FRAME_HEIGHT * FRAME_COUNT,
  maxAggregateOutputPixels: FRAME_WIDTH * FRAME_HEIGHT * FRAME_COUNT,
  maxConcurrentEncoders: 1,
  deadlineMilliseconds: 30_000,
};

async function largeAnimatedGif(): Promise<Buffer> {
  const first = await sharp({
    create: {
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      channels: 4,
      background: "#336699ff",
    },
  })
    .png()
    .toBuffer();
  const second = await sharp({
    create: {
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      channels: 4,
      background: "#cc6633ff",
    },
  })
    .png()
    .toBuffer();
  const frames = Array.from(
    { length: FRAME_COUNT },
    (_, index) => (index % 2 === 0 ? first : second),
  );

  return sharp(frames, { join: { animated: true } })
    .gif({
      delay: Array(FRAME_COUNT).fill(FRAME_DELAY_MS),
      loop: 0,
    })
    .toBuffer();
}

function preserveRecipe() {
  return parseImageRecipe(
    JSON.stringify({
      schema_version: 1,
      animation_policy: "preserve",
      outputs: {
        display: {
          format: "webp",
          resize: {
            mode: "inside",
            width: FRAME_WIDTH,
            allow_upscale: false,
          },
          quality: 85,
          effort: 0,
        },
      },
    }),
    {
      maxRecipeBytes: MAX_IMAGE_RECIPE_BYTES,
      maxOutputs: MAX_IMAGE_RECIPE_OUTPUTS,
      maxDimension: MAX_IMAGE_RECIPE_DIMENSION,
    },
  );
}

describe("large animated image regression", () => {
  test("preserves an animation whose raw stacked height exceeds 16,383 pixels", async () => {
    const input = await largeAnimatedGif();

    const direct = await sharp(input, {
      animated: true,
      pages: -1,
      limitInputPixels: options.maxInputPixels,
    })
      .resize({ width: FRAME_WIDTH, withoutEnlargement: true })
      .webp({ quality: 85, effort: 0 })
      .toBuffer();
    const directMetadata = await sharp(direct, {
      animated: true,
      pages: -1,
    }).metadata();
    expect(directMetadata.pages).toBe(FRAME_COUNT);
    expect(directMetadata.pageHeight).toBe(FRAME_HEIGHT);

    const processed = await processImageRecipe(
      input,
      preserveRecipe(),
      options,
    );
    const output = processed.outputs[0]!;
    const metadata = await sharp(output.bytes, {
      animated: true,
      pages: -1,
    }).metadata();

    expect(output.manifest).toMatchObject({
      animated: true,
      pages: FRAME_COUNT,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
    });
    expect(metadata.pages).toBe(FRAME_COUNT);
    expect(metadata.pageHeight).toBe(FRAME_HEIGHT);
    expect(metadata.height).toBe(FRAME_HEIGHT * FRAME_COUNT);
    expect(metadata.delay).toEqual(Array(FRAME_COUNT).fill(FRAME_DELAY_MS));
    expect(metadata.loop).toBe(0);
  });
});
