import pino, { type Logger } from "pino";
import { readEnumEnv } from "./env";

export const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export function resolveLogLevel(
  environment: NodeJS.ProcessEnv = process.env,
): LogLevel {
  const fallback: LogLevel =
    environment.NODE_ENV === "test" ? "silent" : "info";
  return readEnumEnv("LOG_LEVEL", fallback, LOG_LEVELS, environment);
}

export function createLogger(
  environment: NodeJS.ProcessEnv = process.env,
): Logger {
  return pino({
    level: resolveLogLevel(environment),
    base: { service: "smol-media-processor" },
    messageKey: "msg",
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

/**
 * Process-wide structured logger. Emits one JSON object per line on stdout so
 * container log collectors can index fields without parsing free text.
 * Level comes from `LOG_LEVEL` (default `info`, `silent` under `NODE_ENV=test`).
 */
export const logger: Logger = createLogger();
