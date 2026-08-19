import { describe, expect, test } from "bun:test";
import { createLogger, resolveLogLevel } from "./logger";

describe("logger", () => {
  test("defaults to info outside tests and silent under NODE_ENV=test", () => {
    expect(resolveLogLevel({})).toBe("info");
    expect(resolveLogLevel({ NODE_ENV: "production" })).toBe("info");
    expect(resolveLogLevel({ NODE_ENV: "test" })).toBe("silent");
  });

  test("honours LOG_LEVEL and fails closed on unknown levels", () => {
    expect(resolveLogLevel({ LOG_LEVEL: "debug", NODE_ENV: "test" })).toBe(
      "debug",
    );
    expect(resolveLogLevel({ LOG_LEVEL: " warn " })).toBe("warn");
    expect(() => resolveLogLevel({ LOG_LEVEL: "verbose" })).toThrow(
      /LOG_LEVEL must be one of/,
    );
    expect(createLogger({ LOG_LEVEL: "error" }).level).toBe("error");
  });
});
