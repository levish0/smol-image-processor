import { MediaProcessingError } from "./errors";

export type Deadline = {
  signal: AbortSignal;
  dispose(): void;
};

export function createDeadline(
  parent: AbortSignal,
  milliseconds: number,
): Deadline {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abortFromParent, { once: true });
  if (parent.aborted) {
    abortFromParent();
  }

  const timer = setTimeout(() => {
    controller.abort(
      new MediaProcessingError(
        "processor_unavailable",
        "Media processing deadline exceeded",
      ),
    );
  }, milliseconds);

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", abortFromParent);
    },
  };
}
