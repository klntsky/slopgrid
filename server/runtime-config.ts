import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, dirname, join } from "node:path";

export function runtimeConfig() {
  const database = resolve(
    process.env.DATABASE_PATH ?? ".data/slopgrid.sqlite",
  );
  const directory = dirname(database);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let secret: Buffer;
  if (process.env.KEY_ENCRYPTION_SECRET) {
    if (!/^[a-fA-F0-9]{64}$/.test(process.env.KEY_ENCRYPTION_SECRET))
      throw new Error("KEY_ENCRYPTION_SECRET must be 64 hex characters");
    secret = Buffer.from(process.env.KEY_ENCRYPTION_SECRET, "hex");
  } else {
    if (process.env.NODE_ENV === "production")
      throw new Error("Set KEY_ENCRYPTION_SECRET in production");
    const file = join(directory, "secret");
    if (!existsSync(file)) {
      try {
        writeFileSync(file, randomBytes(32), { mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    secret = readFileSync(file);
  }
  return {
    database,
    secret,
    outputsPath: process.env.OUTPUTS_PATH,
    socket: resolve(
      process.env.GENERATION_SOCKET ?? join(directory, "generation.sock"),
    ),
  };
}
