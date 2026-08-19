import { Value } from "@sinclair/typebox/value";
import sharp from "sharp";
import {
  canonicalJson,
  contentDigest,
  sha256Digest,
} from "../src/shared/canonical-json";
import {
  ImageManifestV1Schema,
  type ImageManifestV1,
} from "../src/contracts/schemas";
import {
  MAX_IMAGE_RECIPE_BYTES,
  MAX_IMAGE_RECIPE_DIMENSION,
  MAX_IMAGE_RECIPE_OUTPUTS,
  parseImageRecipe,
} from "../src/image/recipe";

const [headersPath, responsePath, inputPath, recipePath, healthPath] =
  process.argv.slice(2);
if (!headersPath || !responsePath || !inputPath || !recipePath || !healthPath) {
  throw new Error(
    "usage: verify-image-response <headers> <response> <source-image> <recipe> <health-json>",
  );
}

const [headerText, body, input, recipeText, health] = await Promise.all([
  Bun.file(headersPath).text(),
  Bun.file(responsePath).arrayBuffer().then(Buffer.from),
  Bun.file(inputPath).arrayBuffer().then(Buffer.from),
  Bun.file(recipePath).text(),
  Bun.file(healthPath).json() as Promise<Record<string, unknown>>,
]);
const parsedRecipe = parseImageRecipe(recipeText, {
  maxRecipeBytes: MAX_IMAGE_RECIPE_BYTES,
  maxOutputs: MAX_IMAGE_RECIPE_OUTPUTS,
  maxDimension: MAX_IMAGE_RECIPE_DIMENSION,
});
const contentType = /^content-type:\s*(.+)$/im.exec(headerText)?.[1]?.trim();
if (!contentType) throw new Error("response Content-Type is missing");
const responseLength = /^content-length:\s*(\d+)$/im.exec(headerText)?.[1];
if (responseLength !== undefined) {
  assertEqual(Number(responseLength), body.length, "response Content-Length");
} else if (!/^transfer-encoding:\s*chunked\s*$/im.test(headerText)) {
  throw new Error("response must use Content-Length or chunked transfer");
}
const parts = decodeRelated(body, contentType);
if (parts.length < 2) throw new Error("response has no output parts");

const manifestPart = parts[0]!;
assertEqual(
  manifestPart.headers.get("content-id"),
  "<manifest>",
  "manifest ID",
);
assertEqual(
  manifestPart.headers.get("content-type"),
  "application/json; charset=utf-8",
  "manifest MIME",
);
assertEqual(
  manifestPart.headers.get("content-digest"),
  contentDigest(manifestPart.bytes),
  "manifest digest header",
);
const manifest = JSON.parse(
  manifestPart.bytes.toString("utf8"),
) as ImageManifestV1;
if (!Value.Check(ImageManifestV1Schema, manifest)) {
  throw new Error("manifest does not match image-manifest-v1 schema");
}
assertEqual(
  manifestPart.bytes.toString("utf8"),
  canonicalJson(manifest),
  "canonical manifest bytes",
);
assertEqual(
  manifest.input_digest.value,
  sha256Digest(input).value,
  "input digest",
);
assertEqual(
  manifest.recipe_digest.value,
  parsedRecipe.digest.value,
  "recipe digest",
);
assertEqual(health.service, "smol-media-processor", "health service");
assertEqual(health.schema_version, 1, "health schema version");
assertEqual(
  canonicalJson(health.build_fingerprint),
  canonicalJson(manifest.build_fingerprint),
  "health build fingerprint",
);

const sourceMetadata = await sharp(input, {
  animated: true,
  pages: -1,
}).metadata();
assertEqual(
  manifest.source.width,
  sourceMetadata.autoOrient?.width ?? sourceMetadata.width,
  "source width",
);
assertEqual(
  manifest.source.height,
  sourceMetadata.autoOrient?.height ?? sourceMetadata.height,
  "source height",
);
assertEqual(
  manifest.source.pages,
  sourceMetadata.pages ?? 1,
  "source page count",
);
assertEqual(
  manifest.source.animated,
  (sourceMetadata.pages ?? 1) > 1,
  "source animation flag",
);
if (
  manifest.source.metadata.fields.some(
    (field) => field.sensitivity !== "restricted",
  )
) {
  throw new Error("source metadata contains a non-restricted field");
}
if (
  sourceMetadata.exif !== undefined &&
  manifest.source.metadata.fields.length === 0
) {
  throw new Error("source EXIF was not represented in bounded metadata");
}

const outputIds = Object.keys(manifest.outputs).sort(compareAscii);
assertEqual(
  outputIds.join("\0"),
  parsedRecipe.outputs.map((output) => output.outputId).join("\0"),
  "exact recipe output IDs",
);
assertEqual(parts.length, outputIds.length + 1, "exact output part count");
const geometries = new Set<string>();
for (const [index, outputId] of outputIds.entries()) {
  const part = parts[index + 1]!;
  const output = manifest.outputs[outputId]!;
  assertEqual(
    part.headers.get("content-id"),
    `<output-${outputId}>`,
    "part ID",
  );
  assertEqual(part.headers.get("content-type"), "image/webp", "part MIME");
  assertEqual(
    part.headers.get("content-digest"),
    contentDigest(part.bytes),
    "part digest header",
  );
  assertEqual(part.bytes.length, output.byte_length, "part byte length");
  assertEqual(
    sha256Digest(part.bytes).value,
    output.digest.value,
    "manifest output digest",
  );
  const metadata = await sharp(part.bytes, {
    animated: true,
    pages: -1,
  }).metadata();
  assertEqual(metadata.format, "webp", "output format");
  assertEqual(metadata.width, output.width, "output width");
  assertEqual(
    metadata.pageHeight ?? metadata.height,
    output.height,
    "output height",
  );
  assertEqual(metadata.pages ?? 1, output.pages, "output page count");
  assertEqual((metadata.pages ?? 1) > 1, output.animated, "animation flag");
  geometries.add(`${output.width}x${output.height}`);
  if (
    metadata.exif !== undefined ||
    metadata.icc !== undefined ||
    metadata.xmp !== undefined ||
    metadata.iptc !== undefined
  ) {
    throw new Error(`output ${outputId} contains forbidden metadata`);
  }
}
if (outputIds.length > 1 && geometries.size < 2) {
  throw new Error("multi-output smoke did not produce distinct geometries");
}

console.log(`verified ${outputIds.length} image output parts`);

type DecodedPart = { headers: Map<string, string>; bytes: Buffer };

function decodeRelated(body: Buffer, contentType: string): DecodedPart[] {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (!boundary) throw new Error("multipart boundary is missing");
  const marker = Buffer.from(`--${boundary}`);
  const parts: DecodedPart[] = [];
  let cursor = 0;
  while (true) {
    if (!body.subarray(cursor, cursor + marker.length).equals(marker)) {
      throw new Error("multipart marker mismatch");
    }
    cursor += marker.length;
    if (body.subarray(cursor, cursor + 2).toString("ascii") === "--") {
      cursor += 4;
      break;
    }
    if (body.subarray(cursor, cursor + 2).toString("ascii") !== "\r\n") {
      throw new Error("multipart line break is missing");
    }
    cursor += 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (headerEnd < 0) throw new Error("multipart headers are incomplete");
    const headers = new Map<string, string>();
    for (const line of body
      .subarray(cursor, headerEnd)
      .toString("ascii")
      .split("\r\n")) {
      const separator = line.indexOf(":");
      if (separator <= 0) throw new Error("multipart header is invalid");
      const name = line.slice(0, separator).toLowerCase();
      if (headers.has(name))
        throw new Error(`duplicate multipart header: ${name}`);
      headers.set(name, line.slice(separator + 1).trim());
    }
    cursor = headerEnd + 4;
    const lengthText = headers.get("content-length");
    if (!lengthText || !/^\d+$/.test(lengthText)) {
      throw new Error("part Content-Length is invalid");
    }
    const length = Number(lengthText);
    const bytes = body.subarray(cursor, cursor + length);
    if (bytes.length !== length) throw new Error("part body is truncated");
    parts.push({ headers, bytes });
    cursor += length;
    if (body.subarray(cursor, cursor + 2).toString("ascii") !== "\r\n") {
      throw new Error("part terminator is missing");
    }
    cursor += 2;
  }
  if (cursor !== body.length)
    throw new Error("multipart response has trailing bytes");
  return parts;
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label} mismatch: ${String(actual)} != ${String(expected)}`,
    );
  }
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
