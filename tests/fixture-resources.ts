import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";

let directory: string | undefined;
let database: Promise<string> | undefined;
let tls: { key: string; cert: string } | undefined;

function resourceDirectory() {
  const shared = process.env.SLOPGRID_TEST_RESOURCES;
  if (shared) return shared;
  if (!directory) {
    directory = mkdtempSync(join(tmpdir(), "slopgrid-test-resources-"));
    process.once("exit", closeTestResources);
  }
  return directory;
}

/** Only the process that creates these resources removes them. */
export function closeTestResources() {
  if (!directory) return;
  rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  process.removeListener("exit", closeTestResources);
  directory = undefined;
  database = undefined;
  tls = undefined;
}

/** The template is checkpointed and closed before any fixture copies it. */
export function blankTestDatabase() {
  return (database ??= createBlankTestDatabase());
}

async function createBlankTestDatabase() {
  const path = join(resourceDirectory(), "blank.sqlite");
  if (!process.env.SLOPGRID_TEST_RESOURCES) {
    const store = await Store.open(
      path,
      Buffer.alloc(32, 7),
      join(resourceDirectory(), "blank-output"),
    );
    try {
      store.db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      store.db.close();
    }
    chmodSync(path, 0o400);
  }
  return path;
}

/** TLS material is immutable; servers, ports, and client agents stay private. */
export function localhostTestTLS() {
  if (tls) return tls;
  const root = resourceDirectory();
  const key = join(root, "key.pem"),
    cert = join(root, "cert.pem");
  if (!process.env.SLOPGRID_TEST_RESOURCES) {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
    chmodSync(key, 0o400);
    chmodSync(cert, 0o400);
  }
  tls = Object.freeze({
    key: readFileSync(key, "utf8"),
    cert: readFileSync(cert, "utf8"),
  });
  return tls;
}

/** Prepare once in the runner, then inherit read-only resources in supervisors. */
export async function prepareTestResources() {
  if (!process.env.SLOPGRID_TEST_DATABASE) await blankTestDatabase();
  localhostTestTLS();
  return resourceDirectory();
}
