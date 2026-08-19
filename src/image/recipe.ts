import { MediaProcessingError } from "../shared/errors";
import { Value } from "@sinclair/typebox/value";
import {
  ImageRecipeV1Schema,
  type ImageRecipeV1Wire,
} from "../contracts/schemas";
import {
  canonicalJson,
  sha256Digest,
  type Sha256Digest,
} from "../shared/canonical-json";
import { PROCESSOR_POLICY_V1 } from "../config/policy";
import { validate as validateUniqueJsonKeys } from "json-dup-key-validator";

export const MAX_IMAGE_RECIPE_BYTES = PROCESSOR_POLICY_V1.recipe.max_bytes;
export const MAX_IMAGE_RECIPE_OUTPUTS = PROCESSOR_POLICY_V1.recipe.max_outputs;
export const MAX_IMAGE_RECIPE_DIMENSION =
  PROCESSOR_POLICY_V1.recipe.max_dimension;

export type AnimationPolicy = "reject" | "preserve" | "first_frame";
export type ImageResizeMode = "inside" | "cover";

export type ImageOutputRecipe = {
  outputId: string;
  format: "webp";
  resize: {
    mode: ImageResizeMode;
    width?: number;
    height?: number;
    allowUpscale: false;
  };
  quality: number;
  effort: number;
};

export type ImageRecipe = {
  schemaVersion: 1;
  animationPolicy: AnimationPolicy;
  outputs: ImageOutputRecipe[];
  canonicalJson: string;
  digest: Sha256Digest;
};

export type RecipeLimits = {
  maxRecipeBytes: number;
  maxOutputs: number;
  maxDimension: number;
};

export function parseImageRecipe(
  text: string,
  limits: RecipeLimits,
): ImageRecipe {
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength === 0) {
    throw invalidRecipe("Recipe is required");
  }
  if (byteLength > limits.maxRecipeBytes) {
    throw new MediaProcessingError("limit_exceeded", "Recipe is too large");
  }

  let input: unknown;
  try {
    if (validateUniqueJsonKeys(text) !== undefined) {
      throw new Error("Recipe JSON contains duplicate object members");
    }
    input = JSON.parse(text);
  } catch {
    throw invalidRecipe("Recipe must be valid JSON");
  }

  if (!Value.Check(ImageRecipeV1Schema, input)) {
    throw invalidRecipe("Recipe does not match v1 schema");
  }
  const root = input as ImageRecipeV1Wire;
  const entries = Object.entries(root.outputs);
  if (entries.length > limits.maxOutputs) {
    throw new MediaProcessingError(
      "limit_exceeded",
      "Recipe requests too many outputs",
    );
  }

  const outputs = entries.map(([outputId, value]) =>
    parseOutput(outputId, value, limits),
  );

  outputs.sort((left, right) => compareAscii(left.outputId, right.outputId));

  const normalizedWire: ImageRecipeV1Wire = {
    schema_version: 1,
    animation_policy: root.animation_policy,
    outputs: Object.fromEntries(
      outputs.map((output) => [output.outputId, toWireOutput(output)]),
    ),
  };
  const normalizedJson = canonicalJson(normalizedWire);

  return {
    schemaVersion: 1,
    animationPolicy: root.animation_policy,
    outputs,
    canonicalJson: normalizedJson,
    digest: sha256Digest(normalizedJson),
  };
}

function toWireOutput(
  output: ImageOutputRecipe,
): ImageRecipeV1Wire["outputs"][string] {
  const shared = {
    format: "webp" as const,
    quality: output.quality,
    effort: output.effort,
  };
  if (output.resize.mode === "cover") {
    return {
      ...shared,
      resize: {
        mode: "cover",
        width: output.resize.width!,
        height: output.resize.height!,
        allow_upscale: false,
      },
    };
  }
  if (output.resize.width !== undefined) {
    return {
      ...shared,
      resize: {
        mode: "inside",
        width: output.resize.width,
        ...(output.resize.height === undefined
          ? {}
          : { height: output.resize.height }),
        allow_upscale: false,
      },
    };
  }
  return {
    ...shared,
    resize: {
      mode: "inside",
      height: output.resize.height!,
      allow_upscale: false,
    },
  };
}

function parseOutput(
  outputId: string,
  output: ImageRecipeV1Wire["outputs"][string],
  limits: RecipeLimits,
): ImageOutputRecipe {
  const resize = output.resize;

  const width = parseOptionalDimension(
    resize.width,
    `outputs.${outputId}.resize.width`,
    limits.maxDimension,
  );
  const height = parseOptionalDimension(
    resize.height,
    `outputs.${outputId}.resize.height`,
    limits.maxDimension,
  );
  if (resize.mode === "inside" && width === undefined && height === undefined) {
    throw invalidRecipe(
      `outputs.${outputId} inside resize requires width or height`,
    );
  }

  return {
    outputId,
    format: "webp",
    resize: {
      mode: resize.mode,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      allowUpscale: false,
    },
    quality: output.quality,
    effort: output.effort,
  };
}

function parseOptionalDimension(
  value: unknown,
  label: string,
  max: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return expectIntegerInRange(value, label, 1, max);
}

function expectIntegerInRange(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    throw invalidRecipe(`${label} must be an integer in ${min}..=${max}`);
  }
  return value as number;
}

function invalidRecipe(message: string): MediaProcessingError {
  return new MediaProcessingError("invalid_request", message);
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
