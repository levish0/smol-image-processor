import { describe, expect, test } from "bun:test";
import { loadProcessorConfig, PROCESSOR_HARD_LIMITS } from "./config";
import { IMAGE_HARD_LIMITS } from "./image";
import { VIDEO_DEFAULTS, VIDEO_HARD_LIMITS } from "./video";

describe("loadProcessorConfig", () => {
  test("uses reviewed compiled defaults when variables are absent", () => {
    const config = loadProcessorConfig({});
    expect(config.concurrency).toBe(2);
    expect(config.encoderConcurrency).toBe(2);
    expect(config.serverIdleTimeoutSeconds).toBe(155);
    expect(config.image.maxInputBytes).toBe(IMAGE_HARD_LIMITS.maxInputBytes);
    expect(config.video.maxChildAddressSpaceBytes).toBe(
      VIDEO_DEFAULTS.maxChildAddressSpaceBytes,
    );
  });

  test("accepts exact immutable maxima and rejects max+1", () => {
    expect(
      loadProcessorConfig({
        PROCESSING_CONCURRENCY: String(PROCESSOR_HARD_LIMITS.concurrency),
        ENCODER_CONCURRENCY: "1",
        MAX_IMAGE_INPUT_PIXELS: String(IMAGE_HARD_LIMITS.maxInputPixels),
        MAX_VIDEO_DECODER_WORKING_SET_BYTES: String(
          VIDEO_HARD_LIMITS.maxDecoderWorkingSetBytes,
        ),
      }).image.maxInputPixels,
    ).toBe(IMAGE_HARD_LIMITS.maxInputPixels);

    expect(() =>
      loadProcessorConfig({
        MAX_IMAGE_INPUT_PIXELS: String(IMAGE_HARD_LIMITS.maxInputPixels + 1),
      }),
    ).toThrow("MAX_IMAGE_INPUT_PIXELS must be an integer in");
    expect(() =>
      loadProcessorConfig({
        PROCESSING_CONCURRENCY: String(PROCESSOR_HARD_LIMITS.concurrency + 1),
      }),
    ).toThrow("PROCESSING_CONCURRENCY must be an integer in");
    expect(() =>
      loadProcessorConfig({
        MAX_VIDEO_DECODER_WORKING_SET_BYTES: String(
          VIDEO_HARD_LIMITS.maxDecoderWorkingSetBytes + 1,
        ),
      }),
    ).toThrow("MAX_VIDEO_DECODER_WORKING_SET_BYTES must be an integer in");
  });

  test("fails startup on malformed values instead of falling back or clamping", () => {
    expect(() =>
      loadProcessorConfig({ MAX_IMAGE_INPUT_BYTES: "12px" }),
    ).toThrow("MAX_IMAGE_INPUT_BYTES must be an integer");
    expect(() => loadProcessorConfig({ VIDEO_PRESET: "fastest" })).toThrow(
      "VIDEO_PRESET must be one of",
    );
    expect(() => loadProcessorConfig({ VIDEO_PRESET: "medium" })).toThrow(
      "VIDEO_PRESET must be one of",
    );
    expect(() =>
      loadProcessorConfig({ FFMPEG_ADDRESS_SPACE_LIMIT_BYTES: "768MiB" }),
    ).toThrow("FFMPEG_ADDRESS_SPACE_LIMIT_BYTES must be an integer");
    expect(() =>
      loadProcessorConfig({ FFMPEG_ADDRESS_SPACE_LIMIT_BYTES: "0" }),
    ).toThrow("FFMPEG_ADDRESS_SPACE_LIMIT_BYTES must be an integer in");
  });

  test("uses the operator-selected child address-space limit", () => {
    const selected = 8 * 1024 * 1024 * 1024;
    expect(
      loadProcessorConfig({
        FFMPEG_ADDRESS_SPACE_LIMIT_BYTES: String(selected),
      }).video.maxChildAddressSpaceBytes,
    ).toBe(selected);
  });

  test("keeps the global encoder ceiling across admitted requests", () => {
    expect(() =>
      loadProcessorConfig({
        PROCESSING_CONCURRENCY: "2",
        ENCODER_CONCURRENCY: "3",
      }),
    ).toThrow("exceeds the global encoder ceiling");
  });
});
