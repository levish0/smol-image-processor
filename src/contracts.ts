import { Type, type Static } from "@sinclair/typebox";

const OutputIdKey = Type.RegExp(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const Dimension = Type.Integer({ minimum: 1, maximum: 8192 });

const InsideWidthResize = Type.Object(
  {
    mode: Type.Literal("inside"),
    width: Dimension,
    height: Type.Optional(Dimension),
    allow_upscale: Type.Literal(false),
  },
  { additionalProperties: false },
);
const InsideHeightResize = Type.Object(
  {
    mode: Type.Literal("inside"),
    width: Type.Optional(Dimension),
    height: Dimension,
    allow_upscale: Type.Literal(false),
  },
  { additionalProperties: false },
);
const CoverResize = Type.Object(
  {
    mode: Type.Literal("cover"),
    width: Dimension,
    height: Dimension,
    allow_upscale: Type.Literal(false),
  },
  { additionalProperties: false },
);

const ImageOutputRecipe = Type.Object(
  {
    format: Type.Literal("webp"),
    resize: Type.Union([InsideWidthResize, InsideHeightResize, CoverResize]),
    quality: Type.Integer({ minimum: 1, maximum: 100 }),
    effort: Type.Integer({ minimum: 0, maximum: 6 }),
  },
  { additionalProperties: false },
);

export const ImageRecipeV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    animation_policy: Type.Union([
      Type.Literal("reject"),
      Type.Literal("preserve"),
      Type.Literal("first_frame"),
    ]),
    outputs: Type.Record(OutputIdKey, ImageOutputRecipe, {
      minProperties: 1,
      maxProperties: 8,
      additionalProperties: false,
    }),
  },
  {
    $id: "https://github.com/levish0/smol-media-processor/contracts/image-recipe-v1.schema.json",
    title: "Image processing recipe v1",
    additionalProperties: false,
  },
);

const Digest = Type.Object(
  {
    algorithm: Type.Literal("sha-256"),
    value: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  },
  { additionalProperties: false },
);

const SourceMetadataField = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 64 }),
    value: Type.Union([
      Type.String({ maxLength: 512 }),
      Type.Number(),
      Type.Array(Type.Number(), { maxItems: 16 }),
    ]),
    sensitivity: Type.Literal("restricted"),
  },
  { additionalProperties: false },
);

export const ImageSourceMetadataV1Schema = Type.Object(
  {
    extraction_version: Type.Literal(1),
    fields: Type.Array(SourceMetadataField, { maxItems: 32 }),
  },
  { additionalProperties: false },
);

const ImageSource = Type.Object(
  {
    format: Type.Union([
      Type.Literal("jpeg"),
      Type.Literal("png"),
      Type.Literal("gif"),
      Type.Literal("webp"),
    ]),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    animated: Type.Boolean(),
    pages: Type.Integer({ minimum: 1 }),
    orientation: Type.Union([
      Type.Integer({ minimum: 1, maximum: 8 }),
      Type.Null(),
    ]),
    metadata: ImageSourceMetadataV1Schema,
  },
  { additionalProperties: false },
);

const ImageOutputManifest = Type.Object(
  {
    mime_type: Type.Literal("image/webp"),
    extension: Type.Literal("webp"),
    byte_length: Type.Integer({ minimum: 1 }),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    animated: Type.Boolean(),
    pages: Type.Integer({ minimum: 1 }),
    digest: Digest,
  },
  { additionalProperties: false },
);

export const ImageManifestV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kind: Type.Literal("image"),
    input_digest: Digest,
    recipe_digest: Digest,
    build_fingerprint: Type.Object(
      {
        processor_version: Type.String({ minLength: 1, maxLength: 64 }),
        sharp_version: Type.String({ minLength: 1, maxLength: 64 }),
        libvips_version: Type.String({ minLength: 1, maxLength: 64 }),
        platform: Type.String({ minLength: 1, maxLength: 64 }),
        architecture: Type.String({ minLength: 1, maxLength: 64 }),
        policy_digest: Digest,
      },
      { additionalProperties: false },
    ),
    source: ImageSource,
    outputs: Type.Record(OutputIdKey, ImageOutputManifest, {
      minProperties: 1,
      maxProperties: 8,
      additionalProperties: false,
    }),
  },
  {
    $id: "https://github.com/levish0/smol-media-processor/contracts/image-manifest-v1.schema.json",
    title: "Image processing manifest v1",
    additionalProperties: false,
  },
);

export type ImageRecipeV1Wire = Static<typeof ImageRecipeV1Schema>;
export type ImageManifestV1 = Static<typeof ImageManifestV1Schema>;
export type ImageSourceMetadataV1 = Static<typeof ImageSourceMetadataV1Schema>;

const ProblemBase = {
  title: Type.String({ minLength: 1, maxLength: 256 }),
} as const;

function problemVariant<TCode extends string, TStatus extends number>(
  status: TStatus,
  code: TCode,
) {
  return Type.Object(
    {
      ...ProblemBase,
      type: Type.Literal(
        `https://github.com/levish0/smol-media-processor/problems/${code}`,
      ),
      status: Type.Literal(status),
      code: Type.Literal(code),
    },
    { additionalProperties: false },
  );
}

export const ProblemDetailsV1Schema = Type.Union(
  [
    problemVariant(400, "invalid_request"),
    problemVariant(413, "limit_exceeded"),
    problemVariant(415, "unsupported_media_type"),
    problemVariant(415, "unsupported_format"),
    problemVariant(422, "invalid_image"),
    problemVariant(422, "invalid_video"),
    problemVariant(422, "animation_not_allowed"),
    problemVariant(422, "processing_failed"),
    problemVariant(503, "processor_overloaded"),
    problemVariant(503, "processor_unavailable"),
    problemVariant(500, "internal_error"),
  ],
  {
    $id: "https://github.com/levish0/smol-media-processor/contracts/problem-v1.schema.json",
    title: "Media processor problem response v1",
  },
);

export type ProblemDetailsV1 = Static<typeof ProblemDetailsV1Schema>;
export type ProblemCode = ProblemDetailsV1["code"];
export type ProblemStatus = ProblemDetailsV1["status"];
