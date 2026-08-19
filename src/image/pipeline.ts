import sharp, { type OutputInfo } from "sharp";
import { BUILD_FINGERPRINT } from "../config/build-info";
import { sha256Digest } from "../shared/canonical-json";
import type { ImageManifestV1 } from "../contracts/schemas";
import { createDeadline } from "../shared/deadline";
import { detectMediaKind } from "../shared/detect";
import {
  MediaProcessingError,
  throwIfProcessingAborted,
} from "../shared/errors";
import { logger } from "../shared/logger";
import { PROCESSOR_POLICY_V1 } from "../config/policy";
import type { ImageOutputRecipe, ImageRecipe } from "./recipe";
import {
  extractSourceMetadata,
  type SourceMetadataWorkerFactory,
} from "./source-metadata";

const SUPPORTED_FORMATS = new Set(["jpeg", "png", "gif", "webp"]);
type SharpInstance = ReturnType<typeof sharp>;
type SharpMetadata = Awaited<ReturnType<SharpInstance["metadata"]>>;

export type Digest = ImageManifestV1["input_digest"];
export type ImageSourceManifest = ImageManifestV1["source"];
export type ImageOutputManifest = ImageManifestV1["outputs"][string];
export type ImageProcessingManifest = ImageManifestV1;

export type ProcessedImageOutput = {
  outputId: string;
  filename: string;
  bytes: Buffer;
  manifest: ImageOutputManifest;
};

export type ProcessedImageRecipe = {
  manifest: ImageProcessingManifest;
  outputs: ProcessedImageOutput[];
};

export type ImageProcessingOptions = {
  maxInputBytes: number;
  maxInputPixels: number;
  maxDecodedBytes: number;
  maxPages: number;
  maxAnimationDurationMilliseconds: number;
  maxOutputBytes: number;
  maxAggregateOutputBytes: number;
  maxOutputPixels: number;
  maxAggregateOutputPixels: number;
  maxConcurrentEncoders: number;
  deadlineMilliseconds: number;
};

export type ImageProcessingInstrumentation = {
  onDecodeStart?(): void;
  onEncoderStart?(outputId: string): void;
  onEncoderEnd?(outputId: string): void;
  sourceMetadataWorkerFactory?: SourceMetadataWorkerFactory;
};

const imagePolicy = PROCESSOR_POLICY_V1.image;

export const IMAGE_HARD_LIMITS = {
  maxInputBytes: imagePolicy.max_input_bytes,
  maxInputPixels: imagePolicy.max_input_pixels,
  maxDecodedBytes: imagePolicy.max_decoded_bytes,
  maxPages: imagePolicy.max_pages,
  maxAnimationDurationMilliseconds: imagePolicy.max_animation_duration_ms,
  maxOutputBytes: imagePolicy.max_output_bytes,
  maxAggregateOutputBytes: imagePolicy.max_aggregate_output_bytes,
  maxOutputPixels: imagePolicy.max_output_pixels,
  maxAggregateOutputPixels: imagePolicy.max_aggregate_output_pixels,
  deadlineMilliseconds: imagePolicy.max_deadline_ms,
} as const;

export const IMAGE_DEFAULTS: ImageProcessingOptions = {
  maxInputBytes: IMAGE_HARD_LIMITS.maxInputBytes,
  maxInputPixels: IMAGE_HARD_LIMITS.maxInputPixels,
  maxDecodedBytes: IMAGE_HARD_LIMITS.maxDecodedBytes,
  maxPages: IMAGE_HARD_LIMITS.maxPages,
  maxAnimationDurationMilliseconds:
    IMAGE_HARD_LIMITS.maxAnimationDurationMilliseconds,
  maxOutputBytes: IMAGE_HARD_LIMITS.maxOutputBytes,
  maxAggregateOutputBytes: IMAGE_HARD_LIMITS.maxAggregateOutputBytes,
  maxOutputPixels: IMAGE_HARD_LIMITS.maxOutputPixels,
  maxAggregateOutputPixels: IMAGE_HARD_LIMITS.maxAggregateOutputPixels,
  maxConcurrentEncoders: 2,
  deadlineMilliseconds: 30_000,
};

export async function processImageRecipe(
  input: Buffer,
  recipe: ImageRecipe,
  options = IMAGE_DEFAULTS,
  parentSignal?: AbortSignal,
  instrumentation?: ImageProcessingInstrumentation,
): Promise<ProcessedImageRecipe> {
  const parent = parentSignal ?? new AbortController().signal;
  const deadline = createDeadline(parent, options.deadlineMilliseconds);
  const signal = deadline.signal;
  try {
    throwIfProcessingAborted(signal);
    assertImageInput(input, options);
    const metadata = await readImageMetadata(input, options, signal);
    const source = validateSourceMetadata(metadata, recipe, options);
    preflightOutputBudgets(source, recipe, options);

    const sourceMetadata = metadata.exif
      ? await extractSourceMetadata(
          input,
          signal,
          instrumentation?.sourceMetadataWorkerFactory,
        )
      : { extraction_version: 1 as const, fields: [] };
    throwIfProcessingAborted(signal);

    const decoded = await decodeRawBase(
      input,
      source.outputPages,
      options,
      signal,
      instrumentation,
    );
    const outputs = await renderOutputs(
      decoded,
      metadata,
      source.outputPages,
      recipe,
      options,
      signal,
      instrumentation,
    );

    return {
      manifest: {
        schema_version: 1,
        kind: "image",
        input_digest: sha256Digest(input),
        recipe_digest: recipe.digest,
        build_fingerprint: BUILD_FINGERPRINT,
        source: {
          format: metadata.format as ImageSourceManifest["format"],
          width: source.width,
          height: source.height,
          animated: source.sourcePages > 1,
          pages: source.sourcePages,
          orientation: metadata.orientation ?? null,
          metadata: sourceMetadata,
        },
        outputs: Object.fromEntries(
          outputs.map((output) => [output.outputId, output.manifest]),
        ),
      },
      outputs,
    };
  } finally {
    deadline.dispose();
  }
}

async function readImageMetadata(
  input: Buffer,
  options: ImageProcessingOptions,
  signal: AbortSignal,
): Promise<SharpMetadata> {
  const reader = sharp(input, {
    animated: true,
    pages: -1,
    limitInputPixels: options.maxInputPixels,
  }).timeout({ seconds: Math.ceil(options.deadlineMilliseconds / 1000) });
  const abort = () => reader.destroy(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await reader.metadata().catch((error: unknown) => {
      throwIfProcessingAborted(signal);
      throw normalizeSharpError(error, "Cannot read image metadata");
    });
  } finally {
    signal.removeEventListener("abort", abort);
    reader.destroy();
  }
}

function assertImageInput(
  input: Buffer,
  options: ImageProcessingOptions,
): void {
  if (input.length === 0) {
    throw new MediaProcessingError("invalid_request", "Empty file");
  }
  if (input.length > options.maxInputBytes) {
    throw new MediaProcessingError("limit_exceeded", "Input is too large");
  }
  if (detectMediaKind(input) !== "image") {
    throw new MediaProcessingError(
      "unsupported_format",
      "Input is not a supported raster image",
    );
  }
}

type ValidatedSource = {
  width: number;
  height: number;
  sourcePages: number;
  outputPages: number;
};

function validateSourceMetadata(
  metadata: SharpMetadata,
  recipe: ImageRecipe,
  options: ImageProcessingOptions,
): ValidatedSource {
  if (!metadata.format || !SUPPORTED_FORMATS.has(metadata.format)) {
    throw new MediaProcessingError(
      "unsupported_format",
      `Unsupported image format: ${metadata.format ?? "unknown"}`,
    );
  }

  const width = metadata.autoOrient?.width ?? metadata.width;
  const sourcePages = metadata.pages ?? 1;
  const height = sourceFrameHeight(metadata, sourcePages);
  if (!width || !height || width <= 0 || height <= 0) {
    throw new MediaProcessingError(
      "invalid_image",
      "Image dimensions are invalid",
    );
  }
  if (sourcePages > options.maxPages) {
    throw new MediaProcessingError(
      "limit_exceeded",
      "Image has too many frames",
    );
  }
  if (sourcePages > 1 && recipe.animationPolicy === "reject") {
    throw new MediaProcessingError(
      "animation_not_allowed",
      "Animated image is not allowed by this recipe",
    );
  }

  const outputPages =
    sourcePages > 1 && recipe.animationPolicy === "preserve" ? sourcePages : 1;
  const decodedPixels = multiplyBigInt(width, height, outputPages);
  assertBudget(
    decodedPixels,
    options.maxInputPixels,
    "Image exceeds the decoded pixel limit",
  );
  assertBudget(
    decodedPixels * 4n,
    options.maxDecodedBytes,
    "Image exceeds the decoded byte limit",
  );

  if (outputPages > 1) {
    const delays = metadata.delay;
    if (!delays || delays.length !== sourcePages) {
      throw new MediaProcessingError(
        "invalid_image",
        "Animated image timing metadata is invalid",
      );
    }
    const duration = delays.reduce((total, delay) => total + BigInt(delay), 0n);
    assertBudget(
      duration,
      options.maxAnimationDurationMilliseconds,
      "Animation duration exceeds the limit",
    );
  }

  return { width, height, sourcePages, outputPages };
}

function preflightOutputBudgets(
  source: ValidatedSource,
  recipe: ImageRecipe,
  options: ImageProcessingOptions,
): void {
  let aggregate = 0n;
  for (const output of recipe.outputs) {
    const geometry = outputGeometryUpperBound(
      source.width,
      source.height,
      output,
    );
    const pixels = multiplyBigInt(
      geometry.width,
      geometry.height,
      source.outputPages,
    );
    assertBudget(
      pixels,
      options.maxOutputPixels,
      `Output ${output.outputId} exceeds the pixel limit`,
    );
    aggregate += pixels;
  }
  assertBudget(
    aggregate,
    options.maxAggregateOutputPixels,
    "Outputs exceed the aggregate pixel limit",
  );
}

type RawBase = {
  bytes: Buffer;
  width: number;
  height: number;
  pageHeight: number;
  channels: 4;
};

async function decodeRawBase(
  input: Buffer,
  outputPages: number,
  options: ImageProcessingOptions,
  signal: AbortSignal,
  instrumentation: ImageProcessingInstrumentation | undefined,
): Promise<RawBase> {
  throwIfProcessingAborted(signal);
  instrumentation?.onDecodeStart?.();
  const decoder = sharp(input, {
    animated: outputPages > 1,
    pages: outputPages > 1 ? -1 : 1,
    limitInputPixels: options.maxInputPixels,
  })
    .rotate()
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .timeout({ seconds: Math.ceil(options.deadlineMilliseconds / 1000) });
  const abort = () => decoder.destroy(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const decoded = await decoder
      .toBuffer({ resolveWithObject: true })
      .catch((error: unknown) => {
        throwIfProcessingAborted(signal);
        throw normalizeSharpError(error, "Failed to decode image");
      });
    if (decoded.info.channels !== 4) {
      throw new MediaProcessingError(
        "processing_failed",
        "Decoded image is not RGBA",
      );
    }
    assertBudget(
      BigInt(decoded.data.length),
      options.maxDecodedBytes,
      "Image exceeds the decoded byte limit",
    );
    const pageHeight = decoded.info.height / outputPages;
    if (!Number.isInteger(pageHeight) || pageHeight <= 0) {
      throw new MediaProcessingError(
        "processing_failed",
        "Decoded animation geometry is invalid",
      );
    }
    return {
      bytes: decoded.data,
      width: decoded.info.width,
      height: decoded.info.height,
      pageHeight,
      channels: 4,
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    decoder.destroy();
  }
}

async function renderOutputs(
  raw: RawBase,
  metadata: SharpMetadata,
  outputPages: number,
  recipe: ImageRecipe,
  options: ImageProcessingOptions,
  signal: AbortSignal,
  instrumentation: ImageProcessingInstrumentation | undefined,
): Promise<ProcessedImageOutput[]> {
  const outputs = new Array<ProcessedImageOutput>(recipe.outputs.length);
  const active = new Set<SharpInstance>();
  const budget = new AggregateByteBudget(options.maxAggregateOutputBytes);
  let nextIndex = 0;
  let failure: unknown;

  const cancelActive = (reason: unknown) => {
    void reason;
    for (const encoder of active) {
      encoder.destroy();
    }
  };
  const abort = () => cancelActive(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });

  const worker = async () => {
    while (failure === undefined) {
      const index = nextIndex++;
      if (index >= recipe.outputs.length) {
        return;
      }
      const output = recipe.outputs[index]!;
      try {
        outputs[index] = await renderOutput(
          raw,
          metadata,
          outputPages,
          output,
          options,
          budget,
          active,
          signal,
          instrumentation,
        );
      } catch (error) {
        failure ??= error;
        cancelActive(error);
      }
    }
  };

  try {
    const workers = Array.from(
      {
        length: Math.min(options.maxConcurrentEncoders, recipe.outputs.length),
      },
      worker,
    );
    await Promise.all(workers);
    throwIfProcessingAborted(signal);
    if (failure !== undefined) {
      throw normalizeSharpError(failure, "Failed to process image");
    }
    return outputs;
  } finally {
    signal?.removeEventListener("abort", abort);
    cancelActive(new Error("Image processing completed"));
  }
}

async function renderOutput(
  raw: RawBase,
  metadata: SharpMetadata,
  outputPages: number,
  recipe: ImageOutputRecipe,
  options: ImageProcessingOptions,
  aggregateBudget: AggregateByteBudget,
  active: Set<SharpInstance>,
  signal: AbortSignal,
  instrumentation: ImageProcessingInstrumentation | undefined,
): Promise<ProcessedImageOutput> {
  throwIfProcessingAborted(signal);
  const encoder = sharp(raw.bytes, {
    animated: outputPages > 1,
    pages: outputPages > 1 ? -1 : 1,
    raw: {
      width: raw.width,
      height: raw.height,
      channels: raw.channels,
      ...(outputPages > 1 ? { pageHeight: raw.pageHeight } : {}),
    },
  })
    .resize({
      fit: recipe.resize.mode,
      ...(recipe.resize.width === undefined
        ? {}
        : { width: recipe.resize.width }),
      ...(recipe.resize.height === undefined
        ? {}
        : { height: recipe.resize.height }),
      withoutEnlargement: true,
      position: "centre",
    })
    .webp({
      quality: recipe.quality,
      effort: recipe.effort,
      ...(outputPages > 1
        ? { loop: metadata.loop, delay: metadata.delay }
        : {}),
      force: true,
    })
    .timeout({ seconds: Math.ceil(options.deadlineMilliseconds / 1000) });

  active.add(encoder);
  let instrumentationStarted = false;
  let info: OutputInfo | undefined;
  const chunks: Buffer[] = [];
  let outputBytes = 0n;
  try {
    instrumentationStarted = true;
    instrumentation?.onEncoderStart?.(recipe.outputId);
    encoder.once("info", (value) => {
      info = value;
    });
    for await (const value of encoder) {
      throwIfProcessingAborted(signal);
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      outputBytes += BigInt(chunk.length);
      if (outputBytes > BigInt(options.maxOutputBytes)) {
        throw new MediaProcessingError(
          "limit_exceeded",
          `Output ${recipe.outputId} exceeds the byte limit`,
        );
      }
      aggregateBudget.consume(chunk.length);
      chunks.push(chunk);
    }
    if (!info) {
      throw new MediaProcessingError(
        "processing_failed",
        "Image encoder did not report output metadata",
      );
    }
    const bytes = Buffer.concat(chunks, Number(outputBytes));
    // `info.pages` is the page count of the pipeline *input*, not of the
    // encoded file: the animated WebP encoder may merge consecutive identical
    // frames, so the encoded page count can legitimately be smaller.
    const expectedPages = info.pages ?? outputPages;
    const frameHeight = info.pageHeight ?? info.height;
    assertBudget(
      multiplyBigInt(info.width, frameHeight, expectedPages),
      options.maxOutputPixels,
      `Output ${recipe.outputId} exceeds the pixel limit`,
    );
    const verified = await verifySanitizedOutput(
      bytes,
      {
        outputId: recipe.outputId,
        width: info.width,
        frameHeight,
        maxPages: expectedPages,
      },
      options.deadlineMilliseconds,
      signal,
    );
    return {
      outputId: recipe.outputId,
      filename: `${recipe.outputId}.webp`,
      bytes,
      manifest: {
        mime_type: "image/webp",
        extension: "webp",
        byte_length: bytes.length,
        width: verified.width,
        height: verified.frameHeight,
        animated: verified.pages > 1,
        pages: verified.pages,
        digest: sha256Digest(bytes),
      },
    };
  } catch (error) {
    encoder.destroy();
    throw error;
  } finally {
    active.delete(encoder);
    if (instrumentationStarted) {
      instrumentation?.onEncoderEnd?.(recipe.outputId);
    }
    encoder.destroy();
  }
}

type OutputContract = {
  outputId: string;
  width: number;
  frameHeight: number;
  /** Page count fed to the encoder; the encoded file may contain fewer. */
  maxPages: number;
};

type VerifiedOutput = {
  width: number;
  frameHeight: number;
  pages: number;
};

/**
 * Re-open the encoded bytes and confirm they satisfy the serving contract:
 * WebP, expected geometry, a sane page count, and no embedded metadata.
 *
 * The page count is bounded rather than exact because libwebp's animation
 * encoder merges consecutive frames that are identical (or, for lossy output,
 * within its quality-derived tolerance) into one frame with the summed delay,
 * and emits a still image when everything collapses to a single frame. The
 * caller must therefore take the effective geometry from the returned value.
 */
async function verifySanitizedOutput(
  bytes: Buffer,
  contract: OutputContract,
  deadlineMilliseconds: number,
  signal: AbortSignal,
): Promise<VerifiedOutput> {
  if (detectMediaKind(bytes) !== "image") {
    logger.warn(
      { output_id: contract.outputId, byte_length: bytes.length },
      "Encoder output magic is invalid",
    );
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
  } catch (error) {
    throwIfProcessingAborted(signal);
    logger.warn(
      { output_id: contract.outputId, err: error },
      "Encoder output cannot be verified",
    );
    throw new MediaProcessingError(
      "processing_failed",
      "Encoder output cannot be verified",
    );
  } finally {
    signal.removeEventListener("abort", abort);
    verifier.destroy();
  }

  const pages = metadata.pages ?? 1;
  const actual = {
    format: metadata.format,
    width: metadata.width,
    frame_height: sourceFrameHeight(metadata, pages),
    pages,
    has_exif: metadata.exif !== undefined,
    has_icc: metadata.icc !== undefined,
    has_xmp: metadata.xmp !== undefined,
    has_iptc: metadata.iptc !== undefined,
  };
  const violations: string[] = [];
  if (actual.format !== "webp") violations.push("format");
  if (actual.width !== contract.width) violations.push("width");
  if (actual.frame_height !== contract.frameHeight) violations.push("height");
  if (pages > contract.maxPages) violations.push("pages");
  if (actual.has_exif) violations.push("exif");
  if (actual.has_icc) violations.push("icc");
  if (actual.has_xmp) violations.push("xmp");
  if (actual.has_iptc) violations.push("iptc");
  if (violations.length > 0) {
    logger.warn(
      {
        output_id: contract.outputId,
        violations,
        expected: {
          format: "webp",
          width: contract.width,
          frame_height: contract.frameHeight,
          max_pages: contract.maxPages,
        },
        actual,
      },
      "Encoder output contract verification failed",
    );
    throw new MediaProcessingError(
      "processing_failed",
      `Encoder output contract verification failed (${violations.join(", ")})`,
    );
  }
  if (pages < contract.maxPages) {
    logger.info(
      {
        output_id: contract.outputId,
        input_pages: contract.maxPages,
        encoded_pages: pages,
      },
      "Animated WebP encoder merged consecutive identical frames",
    );
  }
  return {
    width: contract.width,
    frameHeight: contract.frameHeight,
    pages,
  };
}

class AggregateByteBudget {
  readonly #maximum: bigint;
  #used = 0n;

  constructor(maximum: number) {
    this.#maximum = BigInt(maximum);
  }

  consume(bytes: number): void {
    this.#used += BigInt(bytes);
    if (this.#used > this.#maximum) {
      throw new MediaProcessingError(
        "limit_exceeded",
        "Outputs exceed the aggregate byte limit",
      );
    }
  }
}

function outputGeometryUpperBound(
  sourceWidth: number,
  sourceHeight: number,
  output: ImageOutputRecipe,
): { width: bigint; height: bigint } {
  const sourceW = BigInt(sourceWidth);
  const sourceH = BigInt(sourceHeight);
  const requestedW =
    output.resize.width === undefined ? undefined : BigInt(output.resize.width);
  const requestedH =
    output.resize.height === undefined
      ? undefined
      : BigInt(output.resize.height);

  if (output.resize.mode === "cover") {
    return requestedW! * requestedH! <= sourceW * sourceH
      ? { width: requestedW!, height: requestedH! }
      : { width: sourceW, height: sourceH };
  }

  let numerator = 1n;
  let denominator = 1n;
  const consider = (
    candidateNumerator: bigint,
    candidateDenominator: bigint,
  ) => {
    if (candidateNumerator * denominator < numerator * candidateDenominator) {
      numerator = candidateNumerator;
      denominator = candidateDenominator;
    }
  };
  if (requestedW !== undefined) {
    consider(requestedW, sourceW);
  }
  if (requestedH !== undefined) {
    consider(requestedH, sourceH);
  }
  return {
    width: maxBigInt(1n, ceilDivide(sourceW * numerator, denominator)),
    height: maxBigInt(1n, ceilDivide(sourceH * numerator, denominator)),
  };
}

function sourceFrameHeight(metadata: SharpMetadata, pages: number): number {
  const raw = metadata.pageHeight ?? metadata.height;
  const orientation = metadata.orientation ?? 1;
  if (orientation >= 5 && orientation <= 8) {
    return metadata.width;
  }
  if (metadata.pageHeight === undefined && pages > 1 && raw % pages === 0) {
    return raw / pages;
  }
  return raw;
}

function multiplyBigInt(...values: Array<number | bigint>): bigint {
  return values.reduce<bigint>((total, value) => total * BigInt(value), 1n);
}

function assertBudget(value: bigint, maximum: number, message: string): void {
  if (value > BigInt(maximum)) {
    throw new MediaProcessingError("limit_exceeded", message);
  }
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function normalizeSharpError(
  error: unknown,
  fallbackMessage: string,
): MediaProcessingError {
  if (error instanceof MediaProcessingError) {
    return error;
  }
  // The public problem response stays generic; keep the underlying libvips
  // diagnostic in the processor log so failures can be triaged in production.
  logger.warn({ err: error, stage: fallbackMessage }, "Image pipeline error");
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes("pixel limit")
  ) {
    return new MediaProcessingError(
      "limit_exceeded",
      "Image exceeds the decoded pixel limit",
    );
  }
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes("timeout")
  ) {
    return new MediaProcessingError(
      "processor_unavailable",
      "Image processing deadline exceeded",
    );
  }
  return new MediaProcessingError("processing_failed", fallbackMessage);
}
