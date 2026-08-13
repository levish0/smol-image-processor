import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import sharp from "sharp";
import {
  ImageManifestV1Schema,
  ImageRecipeV1Schema,
  ProblemDetailsV1Schema,
} from "./contracts";
import { IMAGE_DEFAULTS, processImageRecipe } from "./image";
import {
  MAX_IMAGE_RECIPE_BYTES,
  MAX_IMAGE_RECIPE_DIMENSION,
  MAX_IMAGE_RECIPE_OUTPUTS,
  parseImageRecipe,
} from "./recipe";
import { problemDetails, PROBLEM_STATUS } from "./errors";

const contracts = [
  ["image-recipe-v1.schema.json", ImageRecipeV1Schema],
  ["image-manifest-v1.schema.json", ImageManifestV1Schema],
  ["problem-v1.schema.json", ProblemDetailsV1Schema],
] as const;
const exampleRecipeUrl = new URL(
  "../contracts/examples/responsive-image-recipe-v1.json",
  import.meta.url,
);

describe("checked v1 contracts", () => {
  test("checked JSON Schemas exactly match their TypeBox source", async () => {
    for (const [filename, source] of contracts) {
      const checked = await Bun.file(
        new URL(`../contracts/${filename}`, import.meta.url),
      ).json();
      expect(checked).toEqual(
        JSON.parse(
          JSON.stringify({
            $schema: "https://json-schema.org/draft/2020-12/schema",
            ...source,
          }),
        ),
      );
    }
  });

  test("the neutral recipe is schema-valid and accepted by the runtime", async () => {
    const [example, text] = await Promise.all([
      Bun.file(exampleRecipeUrl).json(),
      Bun.file(exampleRecipeUrl).text(),
    ]);
    expect(Value.Check(ImageRecipeV1Schema, example)).toBe(true);
    const parsed = parseImageRecipe(text, recipeLimits());
    expect(parsed.outputs.map((output) => output.outputId)).toEqual([
      "large",
      "medium",
      "small",
    ]);
  });

  test("a real processed manifest validates and binds recipe/build identity", async () => {
    const recipe = parseImageRecipe(
      await Bun.file(exampleRecipeUrl).text(),
      recipeLimits(),
    );
    const input = await sharp({
      create: { width: 32, height: 24, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    const result = await processImageRecipe(input, recipe, {
      ...IMAGE_DEFAULTS,
      maxInputBytes: 1024 * 1024,
      maxInputPixels: 1_000_000,
      maxDecodedBytes: 4_000_000,
      maxOutputPixels: 1_000_000,
      maxAggregateOutputPixels: 4_000_000,
    });
    expect(Value.Check(ImageManifestV1Schema, result.manifest)).toBe(true);
    expect(result.manifest.recipe_digest).toEqual(recipe.digest);
    expect(Object.keys(result.manifest.outputs).sort()).toEqual([
      "large",
      "medium",
      "small",
    ]);
  });

  test("every public status/code pair is a schema-valid discriminated union", () => {
    for (const [code, status] of Object.entries(PROBLEM_STATUS)) {
      const problem = problemDetails(
        code as keyof typeof PROBLEM_STATUS,
        "Stable public title",
      );
      expect(problem.status).toBe(status);
      expect(Value.Check(ProblemDetailsV1Schema, problem)).toBe(true);
    }
    expect(
      Value.Check(ProblemDetailsV1Schema, {
        ...problemDetails("invalid_request", "bad"),
        status: 503,
      }),
    ).toBe(false);

    const bounded = problemDetails("invalid_request", "x".repeat(400));
    expect(Array.from(bounded.title)).toHaveLength(256);
    expect(Value.Check(ProblemDetailsV1Schema, bounded)).toBe(true);
  });

  test("checked schemas reject unknown wire fields", async () => {
    const example = (await Bun.file(exampleRecipeUrl).json()) as Record<
      string,
      unknown
    >;
    expect(
      Value.Check(ImageRecipeV1Schema, { ...example, raw_sharp_args: {} }),
    ).toBe(false);
  });

  test("package and frozen lockfile use the same service identity", async () => {
    const [packageJson, lockfile] = await Promise.all([
      Bun.file(new URL("../package.json", import.meta.url)).json(),
      Bun.file(new URL("../bun.lock", import.meta.url)).text(),
    ]);
    expect(packageJson.name).toBe("smol-media-processor");
    expect(lockfile).toContain('"name": "smol-media-processor"');
    expect(lockfile).not.toContain('"name": "smol-image-processor"');
  });
});

function recipeLimits() {
  return {
    maxRecipeBytes: MAX_IMAGE_RECIPE_BYTES,
    maxOutputs: MAX_IMAGE_RECIPE_OUTPUTS,
    maxDimension: MAX_IMAGE_RECIPE_DIMENSION,
  };
}
