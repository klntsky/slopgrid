export function validateE2EPort(port: number): number {
  if (
    !Number.isSafeInteger(port) ||
    (port !== 0 && port < 1024) ||
    port > 65535
  )
    throw new Error("Invalid E2E_PORT");
  return port;
}

export function parseE2EPort(value: string | undefined): number {
  if (value === undefined || value.trim() === "")
    throw new Error("E2E_PORT is required");
  return validateE2EPort(Number(value));
}
