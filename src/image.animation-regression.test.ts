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
  const frames = Array.from({ length: FRAME_COUNT }, (_, index) =>
    index % 2 === 0 ? first : second,
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

describe("large animated image regression", () => {
  test("renders all wiki-file variants above the raw stacked-height boundary", async () => {
    const input = await largeAnimatedGif();

    const direct = await sharp(input, {
      animated: true,
      pages: -1,
      limitInputPixels: options.maxInputPixels,
    })
      .resize({ width: FRAME_WIDTH, withoutEnlargement: true })
      .webp({ quality: 85, effort: 4 })
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
    expect(processed.outputs).toHaveLength(OUTPUT_COUNT);

    for (const output of processed.outputs) {
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
    }
  });
});
