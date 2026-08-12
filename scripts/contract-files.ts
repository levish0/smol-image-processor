import { format } from "prettier";
import {
  ImageManifestV1Schema,
  ImageRecipeV1Schema,
  ProblemDetailsV1Schema,
} from "../src/contracts";

const draft = "https://json-schema.org/draft/2020-12/schema";

export const contractFiles = [
  ["contracts/image-recipe-v1.schema.json", ImageRecipeV1Schema],
  ["contracts/image-manifest-v1.schema.json", ImageManifestV1Schema],
  ["contracts/problem-v1.schema.json", ProblemDetailsV1Schema],
] as const;

export async function renderContract(schema: object): Promise<string> {
  return format(JSON.stringify({ $schema: draft, ...schema }), {
    parser: "json",
  });
}
