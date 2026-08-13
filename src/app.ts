import { Elysia } from "elysia";
import { ConcurrencyGate } from "./concurrency";
import { loadProcessorConfig, type ProcessorConfig } from "./config";
import { detectMediaKind } from "./detect";
import { MediaProcessingError, problemDetails } from "./errors";
import { processImageRecipe, type ProcessedImageRecipe } from "./image";
import { encodeMultipartRelated, parseMultipartRequest } from "./multipart";
import { parseImageRecipe } from "./recipe";
import { processVideo, type ProcessedVideo } from "./video";
import { createDeadline } from "./deadline";
import { canonicalJson } from "./canonical-json";
import { BUILD_FINGERPRINT } from "./build-info";
import type { ProblemCode } from "./contracts";

export type ProcessorDependencies = {
  processImage: typeof processImageRecipe;
  processVideo: typeof processVideo;
};

const defaultDependencies: ProcessorDependencies = {
  processImage: processImageRecipe,
  processVideo,
};

export function createApp(
  config: ProcessorConfig = loadProcessorConfig(),
  dependencies: ProcessorDependencies = defaultDependencies,
) {
  const gate = new ConcurrencyGate(config.concurrency);

  return new Elysia()
    .get("/", () => "Media Processor")
    .get("/health", () => ({
      status: "ok",
      service: "smol-media-processor",
      schema_version: 1,
      build_fingerprint: BUILD_FINGERPRINT,
      ffmpeg_address_space_limit_bytes: config.video.maxChildAddressSpaceBytes,
    }))
    .post(
      "/v1/images/process",
      ({ request }) =>
        handle(() =>
          runWithDeadline(
            request.signal,
            config.image.deadlineMilliseconds,
            (deadline) =>
              gate.runResponse(
                async () => {
                  const parsed = await parseMultipartRequest(request, {
                    maxEnvelopeBytes: config.maxImageRequestBytes,
                    maxFileBytes: config.image.maxInputBytes,
                    maxRecipeBytes: config.recipeLimits.maxRecipeBytes,
                    requireRecipe: true,
                    idleTimeoutMilliseconds: config.requestIdleMilliseconds,
                    signal: deadline.signal,
                  });
                  if (detectMediaKind(parsed.file) !== "image") {
                    throw new MediaProcessingError(
                      "unsupported_format",
                      "Image endpoint accepts JPEG, PNG, GIF, or WebP",
                    );
                  }
                  const recipe = parseImageRecipe(
                    parsed.recipeText ?? "",
                    config.recipeLimits,
                  );
                  const processed = await dependencies.processImage(
                    parsed.file,
                    recipe,
                    config.image,
                    deadline.signal,
                  );
                  return imageResponse(processed);
                },
                { signal: deadline.signal, onRelease: deadline.dispose },
              ),
          ),
        ),
      { parse: "none" },
    )
    .post(
      "/v1/videos/process",
      ({ request }) =>
        handle(() =>
          runWithDeadline(
            request.signal,
            config.video.deadlineMilliseconds,
            (deadline) =>
              gate.runResponse(
                async () => {
                  const parsed = await parseMultipartRequest(request, {
                    maxEnvelopeBytes: config.maxVideoRequestBytes,
                    maxFileBytes: config.video.maxInputBytes,
                    requireRecipe: false,
                    idleTimeoutMilliseconds: config.requestIdleMilliseconds,
                    signal: deadline.signal,
                  });
                  if (detectMediaKind(parsed.file) !== "video") {
                    throw new MediaProcessingError(
                      "unsupported_format",
                      "Video endpoint accepts supported video containers only",
                    );
                  }
                  const processed = await dependencies.processVideo(
                    parsed.file,
                    config.video,
                    deadline.signal,
                  );
                  return videoResponse(processed);
                },
                {
                  exclusive: true,
                  signal: deadline.signal,
                  onRelease: deadline.dispose,
                },
              ),
          ),
        ),
      { parse: "none" },
    );
}

async function runWithDeadline(
  parentSignal: AbortSignal,
  milliseconds: number,
  operation: (deadline: ReturnType<typeof createDeadline>) => Promise<Response>,
): Promise<Response> {
  const deadline = createDeadline(parentSignal, milliseconds);
  try {
    return await operation(deadline);
  } catch (error) {
    deadline.dispose();
    throw error;
  }
}

async function handle(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MediaProcessingError) {
      return problem(error.code, error.message);
    }
    console.error("Unexpected media processing error:", error);
    return problem("internal_error", "Failed to process media");
  }
}

function imageResponse(processed: ProcessedImageRecipe): Response {
  const encoded = encodeMultipartRelated(
    canonicalJson(processed.manifest),
    processed.outputs.map((output) => ({
      contentId: `output-${output.outputId}`,
      filename: output.filename,
      mimeType: output.manifest.mime_type,
      bytes: output.bytes,
    })),
  );
  return new Response(streamBuffer(encoded.body), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-length": String(encoded.body.length),
      "content-type": encoded.contentType,
    },
  });
}

function videoResponse(processed: ProcessedVideo): Response {
  return new Response(streamBuffer(processed.bytes), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-disposition": 'inline; filename="output.mp4"',
      "content-length": String(processed.bytes.length),
      "content-type": processed.mimeType,
      "x-smp-schema-version": "1",
      "x-smp-width": String(processed.width),
      "x-smp-height": String(processed.height),
      "x-smp-duration-seconds": String(processed.durationSeconds),
      "x-smp-has-audio": processed.hasAudio ? "true" : "false",
    },
  });
}

function streamBuffer(buffer: Buffer): ReadableStream<Uint8Array> {
  const bytes = new Uint8Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 64 * 1024, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

function problem(code: ProblemCode, title: string): Response {
  const body = problemDetails(code, title);
  return Response.json(body, {
    status: body.status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/problem+json",
    },
  });
}
