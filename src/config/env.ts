const INTEGER_ENV_PATTERN = /^[+-]?\d+$/;

export function readBoundedInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const raw = environment[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = parseInteger(name, raw);
  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer in ${min}..=${max}`);
  }
  return parsed;
}

export function readEnumEnv<T extends string>(
  name: string,
  fallback: T,
  allowed: readonly T[],
  environment: NodeJS.ProcessEnv = process.env,
): T {
  const raw = environment[name];
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim();
  if (!(allowed as readonly string[]).includes(normalized)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return normalized as T;
}

function parseInteger(name: string, raw: string): number {
  const normalized = raw.trim();
  if (!INTEGER_ENV_PATTERN.test(normalized)) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return parsed;
}
