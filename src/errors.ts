import type { ProblemCode, ProblemDetailsV1, ProblemStatus } from "./contracts";

export const PROBLEM_STATUS = {
  invalid_request: 400,
  limit_exceeded: 413,
  unsupported_media_type: 415,
  unsupported_format: 415,
  invalid_image: 422,
  invalid_video: 422,
  animation_not_allowed: 422,
  processing_failed: 422,
  processor_overloaded: 503,
  processor_unavailable: 503,
  internal_error: 500,
} as const satisfies Record<ProblemCode, ProblemStatus>;

export class MediaProcessingError extends Error {
  readonly status: ProblemStatus;
  readonly code: ProblemCode;

  constructor(code: ProblemCode, message: string) {
    super(message);
    this.name = "MediaProcessingError";
    this.code = code;
    this.status = PROBLEM_STATUS[code];
  }
}

export function throwIfProcessingAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    if (signal.reason instanceof MediaProcessingError) {
      throw signal.reason;
    }
    throw new MediaProcessingError("invalid_request", "Request was cancelled");
  }
}

export function problemDetails(
  code: ProblemCode,
  title: string,
): ProblemDetailsV1 {
  return {
    type: `https://github.com/levish0/smol-media-processor/problems/${code}`,
    title: truncateProblemTitle(title),
    status: PROBLEM_STATUS[code],
    code,
  } as ProblemDetailsV1;
}

function truncateProblemTitle(title: string): string {
  const normalized = title.length === 0 ? "Media processing failed" : title;
  return Array.from(normalized).slice(0, 256).join("");
}
