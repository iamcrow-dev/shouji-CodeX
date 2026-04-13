export const DEFAULT_PORT = 333;

export function normalizePort(value, fallback = DEFAULT_PORT) {
  const candidate =
    typeof value === "string" ? Number.parseInt(value.trim(), 10) : Number(value);

  if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) {
    return candidate;
  }

  return fallback;
}

export function ensureValidPort(value) {
  const port = normalizePort(value, NaN);
  if (!Number.isInteger(port)) {
    throw new Error("端口必须是 1-65535 之间的整数");
  }

  return port;
}
