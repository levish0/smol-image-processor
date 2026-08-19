import { MediaProcessingError } from "../shared/errors";

export class ConcurrencyGate {
  readonly #capacity: number;
  #used = 0;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error("Concurrency limit must be a positive integer");
    }
    this.#capacity = capacity;
  }

  async runResponse(
    operation: () => Promise<Response>,
    options: {
      exclusive?: boolean;
      signal?: AbortSignal;
      onRelease?: () => void;
    } = {},
  ): Promise<Response> {
    const weight = options.exclusive ? this.#capacity : 1;
    const releaseAdmission = this.#acquire(weight);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        options.onRelease?.();
      } finally {
        releaseAdmission();
      }
    };
    try {
      return holdLeaseUntilBodyCompletion(
        await operation(),
        release,
        options.signal,
      );
    } catch (error) {
      release();
      throw error;
    }
  }

  #acquire(weight: number): () => void {
    if (this.#used + weight > this.#capacity) {
      throw new MediaProcessingError(
        "processor_overloaded",
        "Processor concurrency limit reached",
      );
    }

    this.#used += weight;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#used -= weight;
    };
  }
}

function holdLeaseUntilBodyCompletion(
  response: Response,
  release: () => void,
  signal?: AbortSignal,
): Response {
  if (response.body === null) {
    release();
    return response;
  }

  const reader = response.body.getReader();
  let settled = false;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  const removeAbortListener = () => signal?.removeEventListener("abort", abort);
  const abort = () => {
    if (settled) return;
    settled = true;
    removeAbortListener();
    const reason = signal?.reason ?? new Error("Response delivery aborted");
    void reader
      .cancel(reason)
      .catch(() => {
        // The deadline still owns the terminal response state.
      })
      .finally(() => {
        try {
          output?.error(reason);
        } finally {
          release();
        }
      });
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    },
    async pull(controller) {
      if (settled) return;
      try {
        const next = await reader.read();
        if (settled) return;
        if (next.done) {
          settled = true;
          removeAbortListener();
          release();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        if (settled) return;
        settled = true;
        removeAbortListener();
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (settled) return;
      settled = true;
      removeAbortListener();
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
