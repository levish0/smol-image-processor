import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { ImageRecipeV1Schema } from "../contracts/schemas";
import { parseImageRecipe, type RecipeLimits } from "./recipe";

const limits: RecipeLimits = {
  maxRecipeBytes: 4096,
  maxOutputs: 3,
  maxDimension: 2048,
};

function valid(outputId = "medium") {
  return {
    schema_version: 1,
    animation_policy: "reject",
    outputs: {
      [outputId]: {
        format: "webp",
        resize: { mode: "inside", width: 640, allow_upscale: false },
        quality: 85,
        effort: 4,
      },
    },
  };
}

describe("parseImageRecipe", () => {
  test("uses output IDs as unique object keys and canonicalizes their order", () => {
    const input = valid("z");
    input.outputs.a = { ...input.outputs.z! };
    const parsed = parseImageRecipe(JSON.stringify(input), limits);

    expect(parsed.outputs.map((output) => output.outputId)).toEqual(["a", "z"]);
    expect(parsed.outputs[0]?.resize.allowUpscale).toBe(false);
    expect(parsed.canonicalJson.indexOf('"a"')).toBeLessThan(
      parsed.canonicalJson.indexOf('"z"'),
    );
    expect(parsed.digest.value).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects duplicate JSON members before schema validation and JCS", () => {
    const base = JSON.stringify(valid());
    const duplicateTopLevel = base.replace(
      '"animation_policy":"reject"',
      '"animation_policy":"reject","animation_policy":"first_frame"',
    );
    const duplicateEscapedKey = base.replace(
      '"quality":85',
      '"quality":85,"\\u0071uality":50',
    );

    expect(() => parseImageRecipe(duplicateTopLevel, limits)).toThrow(
      "valid JSON",
    );
    expect(() => parseImageRecipe(duplicateEscapedKey, limits)).toThrow(
      "valid JSON",
    );
  });

  test("keeps the generated structural schema and runtime parser aligned", () => {
    const input = valid();
    expect(Value.Check(ImageRecipeV1Schema, input)).toBe(true);
    expect(() => parseImageRecipe(JSON.stringify(input), limits)).not.toThrow();

    Object.assign(input.outputs.medium!.resize, { gravity: "north" });
    expect(Value.Check(ImageRecipeV1Schema, input)).toBe(false);
    expect(() => parseImageRecipe(JSON.stringify(input), limits)).toThrow(
      "does not match v1 schema",
    );
  });

  test("rejects unsafe output keys and all upscale requests", () => {
    expect(() =>
      parseImageRecipe(JSON.stringify(valid("../unsafe")), limits),
    ).toThrow("does not match v1 schema");

    const upscale = valid();
    upscale.outputs.medium!.resize.allow_upscale = true;
    expect(() => parseImageRecipe(JSON.stringify(upscale), limits)).toThrow(
      "does not match v1 schema",
    );
  });

  test("requires exact cover geometry and bounded dimensions", () => {
    const cover = valid();
    cover.outputs.medium!.resize = {
      mode: "cover",
      width: 100,
      allow_upscale: false,
    };
    expect(() => parseImageRecipe(JSON.stringify(cover), limits)).toThrow(
      "does not match v1 schema",
    );

    const oversized = valid();
    oversized.outputs.medium!.resize.width = limits.maxDimension + 1;
    expect(() => parseImageRecipe(JSON.stringify(oversized), limits)).toThrow(
      "1..=2048",
    );
  });

  test("enforces output count and recipe byte boundaries", () => {
    const count = valid("a");
    count.outputs.b = { ...count.outputs.a! };
    count.outputs.c = { ...count.outputs.a! };
    count.outputs.d = { ...count.outputs.a! };
    expect(() => parseImageRecipe(JSON.stringify(count), limits)).toThrow(
      "too many outputs",
    );

    const exact = JSON.stringify(valid());
    expect(
      parseImageRecipe(exact, {
        ...limits,
        maxRecipeBytes: Buffer.byteLength(exact),
      }),
    ).toBeDefined();
    expect(() =>
      parseImageRecipe(exact, {
        ...limits,
        maxRecipeBytes: Buffer.byteLength(exact) - 1,
      }),
    ).toThrow("too large");
  });

  test("supports all explicit animation policies and rejects unknown values", () => {
    for (const animation_policy of ["reject", "preserve", "first_frame"]) {
      expect(() =>
        parseImageRecipe(
          JSON.stringify({ ...valid(), animation_policy }),
          limits,
        ),
      ).not.toThrow();
    }
    expect(() =>
      parseImageRecipe(
        JSON.stringify({ ...valid(), animation_policy: "flatten" }),
        limits,
      ),
    ).toThrow("does not match v1 schema");
  });
});
