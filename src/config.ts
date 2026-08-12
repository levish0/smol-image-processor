import { readBoundedInt, readEnumEnv } from "./env";
import {
  IMAGE_DEFAULTS,
  IMAGE_HARD_LIMITS,
  type ImageProcessingOptions,
} from "./image";
import {
  MAX_IMAGE_RECIPE_BYTES,
  MAX_IMAGE_RECIPE_DIMENSION,
  MAX_IMAGE_RECIPE_OUTPUTS,
  type RecipeLimits,
} from "./recipe";
import {
  VIDEO_DEFAULTS,
  VIDEO_HARD_LIMITS,
  VIDEO_PRESETS,
  type VideoOptions,
} from "./video";
import { PROCESSOR_POLICY_V1 } from "./policy";

const MULTIPART_OVERHEAD_ALLOWANCE = 64 * 1024;

export type ProcessorConfig = {
  port: number;
  serverIdleTimeoutSeconds: number;
  concurrency: number;
  encoderConcurrency: number;
  requestIdleMilliseconds: number;
  recipeLimits: RecipeLimits;
  image: ImageProcessingOptions;
  video: VideoOptions;
  maxImageRequestBytes: number;
  maxVideoRequestBytes: number;
};

export const PROCESSOR_HARD_LIMITS = {
  concurrency: PROCESSOR_POLICY_V1.request.max_concurrency,
  encoderConcurrency: PROCESSOR_POLICY_V1.request.max_encoder_concurrency,
  requestIdleSeconds: PROCESSOR_POLICY_V1.request.max_idle_seconds,
  requestEnvelopeBytes: PROCESSOR_POLICY_V1.request.max_envelope_bytes,
} as const;

export function loadProcessorConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ProcessorConfig {
  const recipeLimits: RecipeLimits = {
    maxRecipeBytes: readBoundedInt(
      "MAX_RECIPE_BYTES",
      MAX_IMAGE_RECIPE_BYTES,
      1,
      MAX_IMAGE_RECIPE_BYTES,
      environment,
    ),
    maxOutputs: readBoundedInt(
      "MAX_RECIPE_OUTPUTS",
      MAX_IMAGE_RECIPE_OUTPUTS,
      1,
      MAX_IMAGE_RECIPE_OUTPUTS,
      environment,
    ),
    maxDimension: readBoundedInt(
      "MAX_RECIPE_DIMENSION",
      MAX_IMAGE_RECIPE_DIMENSION,
      1,
      MAX_IMAGE_RECIPE_DIMENSION,
      environment,
    ),
  };
  const concurrency = readBoundedInt(
    "PROCESSING_CONCURRENCY",
    2,
    1,
    PROCESSOR_HARD_LIMITS.concurrency,
    environment,
  );
  const encoderConcurrency = readBoundedInt(
    "ENCODER_CONCURRENCY",
    2,
    1,
    PROCESSOR_HARD_LIMITS.encoderConcurrency,
    environment,
  );
  if (
    concurrency * encoderConcurrency >
    PROCESSOR_HARD_LIMITS.encoderConcurrency
  ) {
    throw new Error(
      "PROCESSING_CONCURRENCY * ENCODER_CONCURRENCY exceeds the global encoder ceiling",
    );
  }
  const image = loadImageOptions(environment, encoderConcurrency);
  const video = loadVideoOptions(environment);
  const minimumImageEnvelope = safeAdd(
    image.maxInputBytes,
    recipeLimits.maxRecipeBytes,
    MULTIPART_OVERHEAD_ALLOWANCE,
  );
  const minimumVideoEnvelope = safeAdd(
    video.maxInputBytes,
    MULTIPART_OVERHEAD_ALLOWANCE,
  );
  const maxImageRequestBytes = readBoundedInt(
    "MAX_IMAGE_REQUEST_BYTES",
    minimumImageEnvelope,
    minimumImageEnvelope,
    PROCESSOR_HARD_LIMITS.requestEnvelopeBytes,
    environment,
  );
  const maxVideoRequestBytes = readBoundedInt(
    "MAX_VIDEO_REQUEST_BYTES",
    minimumVideoEnvelope,
    minimumVideoEnvelope,
    PROCESSOR_HARD_LIMITS.requestEnvelopeBytes,
    environment,
  );
  if (maxImageRequestBytes < minimumImageEnvelope) {
    throw new Error(
      "MAX_IMAGE_REQUEST_BYTES must fit MAX_IMAGE_INPUT_BYTES, MAX_RECIPE_BYTES, and multipart overhead",
    );
  }
  if (maxVideoRequestBytes < minimumVideoEnvelope) {
    throw new Error(
      "MAX_VIDEO_REQUEST_BYTES must fit MAX_VIDEO_INPUT_BYTES and multipart overhead",
    );
  }

  return {
    port: readBoundedInt("PORT", 6701, 1, 65_535, environment),
    serverIdleTimeoutSeconds:
      Math.ceil(
        Math.max(image.deadlineMilliseconds, video.deadlineMilliseconds) / 1000,
      ) + 5,
    concurrency,
    encoderConcurrency,
    requestIdleMilliseconds:
      readBoundedInt(
        "REQUEST_IDLE_TIMEOUT_SECONDS",
        10,
        1,
        PROCESSOR_HARD_LIMITS.requestIdleSeconds,
        environment,
      ) * 1000,
    recipeLimits,
    image,
    video,
    maxImageRequestBytes,
    maxVideoRequestBytes,
  };
}

function loadImageOptions(
  environment: NodeJS.ProcessEnv,
  maxConcurrentEncoders: number,
): ImageProcessingOptions {
  return {
    maxInputBytes: bounded(
      "MAX_IMAGE_INPUT_BYTES",
      IMAGE_DEFAULTS.maxInputBytes,
      IMAGE_HARD_LIMITS.maxInputBytes,
      environment,
    ),
    maxInputPixels: bounded(
      "MAX_IMAGE_INPUT_PIXELS",
      IMAGE_DEFAULTS.maxInputPixels,
      IMAGE_HARD_LIMITS.maxInputPixels,
      environment,
    ),
    maxDecodedBytes: bounded(
      "MAX_IMAGE_DECODED_BYTES",
      IMAGE_DEFAULTS.maxDecodedBytes,
      IMAGE_HARD_LIMITS.maxDecodedBytes,
      environment,
    ),
    maxPages: bounded(
      "MAX_IMAGE_PAGES",
      IMAGE_DEFAULTS.maxPages,
      IMAGE_HARD_LIMITS.maxPages,
      environment,
    ),
    maxAnimationDurationMilliseconds: bounded(
      "MAX_IMAGE_ANIMATION_DURATION_MS",
      IMAGE_DEFAULTS.maxAnimationDurationMilliseconds,
      IMAGE_HARD_LIMITS.maxAnimationDurationMilliseconds,
      environment,
    ),
    maxOutputBytes: bounded(
      "MAX_IMAGE_OUTPUT_BYTES",
      IMAGE_DEFAULTS.maxOutputBytes,
      IMAGE_HARD_LIMITS.maxOutputBytes,
      environment,
    ),
    maxAggregateOutputBytes: bounded(
      "MAX_IMAGE_AGGREGATE_OUTPUT_BYTES",
      IMAGE_DEFAULTS.maxAggregateOutputBytes,
      IMAGE_HARD_LIMITS.maxAggregateOutputBytes,
      environment,
    ),
    maxOutputPixels: bounded(
      "MAX_IMAGE_OUTPUT_PIXELS",
      IMAGE_DEFAULTS.maxOutputPixels,
      IMAGE_HARD_LIMITS.maxOutputPixels,
      environment,
    ),
    maxAggregateOutputPixels: bounded(
      "MAX_IMAGE_AGGREGATE_OUTPUT_PIXELS",
      IMAGE_DEFAULTS.maxAggregateOutputPixels,
      IMAGE_HARD_LIMITS.maxAggregateOutputPixels,
      environment,
    ),
    maxConcurrentEncoders,
    deadlineMilliseconds:
      bounded(
        "IMAGE_PROCESSING_DEADLINE_SECONDS",
        IMAGE_DEFAULTS.deadlineMilliseconds / 1000,
        IMAGE_HARD_LIMITS.deadlineMilliseconds / 1000,
        environment,
      ) * 1000,
  };
}

function loadVideoOptions(environment: NodeJS.ProcessEnv): VideoOptions {
  return {
    maxInputBytes: bounded(
      "MAX_VIDEO_INPUT_BYTES",
      VIDEO_DEFAULTS.maxInputBytes,
      VIDEO_HARD_LIMITS.maxInputBytes,
      environment,
    ),
    maxOutputBytes: bounded(
      "MAX_VIDEO_OUTPUT_BYTES",
      VIDEO_DEFAULTS.maxOutputBytes,
      VIDEO_HARD_LIMITS.maxOutputBytes,
      environment,
    ),
    maxDurationSeconds: bounded(
      "MAX_VIDEO_DURATION_SECONDS",
      VIDEO_DEFAULTS.maxDurationSeconds,
      VIDEO_HARD_LIMITS.maxDurationSeconds,
      environment,
    ),
    maxInputDimension: bounded(
      "MAX_VIDEO_INPUT_DIMENSION",
      VIDEO_DEFAULTS.maxInputDimension,
      VIDEO_HARD_LIMITS.maxInputDimension,
      environment,
    ),
    maxFrameRate: bounded(
      "MAX_VIDEO_FRAME_RATE",
      VIDEO_DEFAULTS.maxFrameRate,
      VIDEO_HARD_LIMITS.maxFrameRate,
      environment,
    ),
    maxDecodePixels: bounded(
      "MAX_VIDEO_DECODE_PIXELS",
      VIDEO_DEFAULTS.maxDecodePixels,
      VIDEO_HARD_LIMITS.maxDecodePixels,
      environment,
    ),
    maxDecoderWorkingSetBytes: bounded(
      "MAX_VIDEO_DECODER_WORKING_SET_BYTES",
      VIDEO_DEFAULTS.maxDecoderWorkingSetBytes,
      VIDEO_HARD_LIMITS.maxDecoderWorkingSetBytes,
      environment,
    ),
    maxChildAddressSpaceBytes: VIDEO_HARD_LIMITS.maxChildAddressSpaceBytes,
    maxDimension: bounded(
      "MAX_VIDEO_DIMENSION",
      VIDEO_DEFAULTS.maxDimension,
      VIDEO_HARD_LIMITS.maxDimension,
      environment,
    ),
    deadlineMilliseconds:
      bounded(
        "VIDEO_PROCESSING_DEADLINE_SECONDS",
        VIDEO_DEFAULTS.deadlineMilliseconds / 1000,
        VIDEO_HARD_LIMITS.deadlineMilliseconds / 1000,
        environment,
      ) * 1000,
    crf: readBoundedInt(
      "VIDEO_CRF",
      VIDEO_DEFAULTS.crf,
      VIDEO_HARD_LIMITS.minCrf,
      VIDEO_HARD_LIMITS.maxCrf,
      environment,
    ),
    preset: readEnumEnv(
      "VIDEO_PRESET",
      VIDEO_DEFAULTS.preset,
      VIDEO_PRESETS,
      environment,
    ),
    audioBitrateKbps: bounded(
      "VIDEO_AUDIO_BITRATE_KBPS",
      VIDEO_DEFAULTS.audioBitrateKbps,
      VIDEO_HARD_LIMITS.audioBitrateKbps,
      environment,
    ),
  };
}

function bounded(
  name: string,
  fallback: number,
  maximum: number,
  environment: NodeJS.ProcessEnv,
): number {
  return readBoundedInt(name, fallback, 1, maximum, environment);
}

function safeAdd(...values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) {
    throw new Error("Processor byte limits exceed the safe integer range");
  }
  return total;
}
