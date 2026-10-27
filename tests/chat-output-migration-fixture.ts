import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { encrypt } from "../server/encryption.js";
import { generatedDataUrl } from "./chat-image-output-fixture.js";
import { pixelPng, referencePng } from "./reference-image-fixture.js";
import type { Model } from "../server/provider.js";
import { migrationWorkerEnvironment } from "./database-output-fixture.js";
import { crashCheckpoint, type CrashCheckpoint } from "./crash-checkpoint.js";

export const chatMigrationModels: readonly Model[] = [
  {
    id: "retired/multimodal",
    name: "Historical multimodal fixture",
    image: false,
    imageInput: true,
    text: true,
    chatImageOutput: true,
    reasoning: false,
    reasoningMandatory: false,
  },
];

export type CanonicalImageJSON = {
  name: string;
  mediaType: string;
  width: number;
  height: number;
  dataUrl: string;
};
export type CanonicalMessageJSON = {
  role: string;
  content: string;
  images?: CanonicalImageJSON[];
};
type Reference = { id: string; name: string; width: number; height: number };
export type StoredChatTask = {
  id: string;
  grid_id: string;
  status: string;
  artifact_id: string | null;
  thinking_source_id: string | null;
  data: {
    input: {
      messages: { role: string; content: string; images?: Reference[] }[];
    };
    output?: { provenance: unknown; usage?: unknown; thinkingId?: string };
    progress?: { draft?: string; thinkingId?: string };
    attemptId?: string;
    error?: string;
  };
};

const secret = Buffer.alloc(32, 23);
const createdAt = "2025-06-07T08:09:10.000Z";
const thinkingId = "a".repeat(48);
const references = {
  wide: {
    id: "wide-reference",
    name: "original-wide.png",
    width: 7,
    height: 3,
  },
  small: {
    id: "small-reference",
    name: "original-small.png",
    width: 1,
    height: 1,
  },
};
const bytes = new Map([
  [references.wide.id, referencePng],
  [references.small.id, pixelPng],
]);
export const migrationDestinations = ["source", "destination"] as const;
export type MigrationDestination = (typeof migrationDestinations)[number];

function suppliedImages(destination: MigrationDestination) {
  return destination === "source"
    ? {
        user: [
          { ...references.wide, name: "source-first.png" },
          { ...references.small, name: "source-second.png" },
        ],
        assistant: [{ ...references.small, name: "source-prior.png" }],
      }
    : {
        user: [
          { ...references.small, name: "destination-first.png" },
          { ...references.wide, name: "destination-second.png" },
        ],
        assistant: [{ ...references.wide, name: "destination-prior.png" }],
      };
}
function template(destination: MigrationDestination) {
  const supplied = suppliedImages(destination);
  return [
    { role: "system", content: "Keep every supplied image in order." },
    { role: "user", content: "Compare these.", images: supplied.user },
    { role: "assistant", content: "Prior frame.", images: supplied.assistant },
    { role: "user", content: "Generate the next frame." },
    { role: "unfilled", content: "" },
    { role: "user", content: "Describe the generated frame." },
    { role: "unfilled", content: "" },
  ];
}
const generatedImage: CanonicalImageJSON = {
  name: "historic-generated.png",
  mediaType: "image/png",
  width: 1,
  height: 1,
  dataUrl: generatedDataUrl,
};
const oldTranscript = [
  { role: "system", content: "Keep every supplied image in order." },
  { role: "user", content: "Compare these." },
  { role: "assistant", content: "Prior frame." },
  { role: "user", content: "Generate the next frame." },
  {
    role: "assistant",
    content: "Generated frame.",
    images: [{ kind: "generated", ...generatedImage }],
  },
  { role: "user", content: "Describe the generated frame." },
  { role: "assistant", content: "A small white frame." },
];

export function expectedMigratedMessages(
  destination: MigrationDestination,
): CanonicalMessageJSON[] {
  const supplied = suppliedImages(destination);
  const canonical = ({ id, name, width, height }: Reference) => ({
    name,
    mediaType: "image/png",
    width,
    height,
    dataUrl: `data:image/png;base64,${bytes.get(id)!.toString("base64")}`,
  });
  return oldTranscript.map((message, index) => ({
    role: message.role,
    content: message.content,
    ...(index === 1
      ? { images: supplied.user.map(canonical) }
      : index === 2
        ? { images: supplied.assistant.map(canonical) }
        : index === 4
          ? { images: [{ ...generatedImage }] }
          : {}),
  }));
}

// Frozen v19 storage, including the PR's generated-kind image format.
// Do not seed historical storage through current schema or transcript writers.
const version19Schema = `
  CREATE TABLE grids (id TEXT PRIMARY KEY, data TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT '', owner_user_id TEXT,
    published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
    visibility TEXT NOT NULL DEFAULT '', slug TEXT, created_at TEXT NOT NULL DEFAULT '') STRICT;
  CREATE TABLE workflow_tasks (
    id TEXT PRIMARY KEY, grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, status TEXT NOT NULL, dependency_id TEXT REFERENCES workflow_tasks(id),
    artifact_id TEXT, thinking_source_id TEXT, data TEXT NOT NULL) STRICT;
  CREATE INDEX workflow_tasks_grid ON workflow_tasks(grid_id);
  CREATE INDEX workflow_tasks_artifact ON workflow_tasks(artifact_id) WHERE artifact_id IS NOT NULL;
  CREATE INDEX workflow_tasks_thinking_source ON workflow_tasks(thinking_source_id) WHERE thinking_source_id IS NOT NULL;
  CREATE TABLE cells (id TEXT PRIMARY KEY, grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, data TEXT NOT NULL,
    generation_id TEXT REFERENCES workflow_tasks(id), judgment_id TEXT REFERENCES workflow_tasks(id),
    UNIQUE (grid_id,position)) STRICT;
  CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL,
    anonymous_id TEXT, created_at INTEGER NOT NULL DEFAULT 0) STRICT;
  CREATE TABLE inference_calls (id TEXT PRIMARY KEY, cell_id TEXT NOT NULL REFERENCES cells(id),
    started_at INTEGER NOT NULL, data TEXT NOT NULL, attempt_id TEXT,
    phase TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', cost_usd REAL,
    task_id TEXT REFERENCES workflow_tasks(id)) STRICT;
  CREATE INDEX inference_calls_cell ON inference_calls(cell_id,started_at);
  CREATE INDEX inference_calls_started ON inference_calls(started_at DESC,id DESC);
  CREATE INDEX inference_calls_attempt ON inference_calls(task_id,attempt_id,started_at);
  CREATE INDEX inference_calls_task ON inference_calls(task_id,started_at);
  CREATE INDEX inference_calls_running ON inference_calls(status) WHERE status='running';
  CREATE TABLE users (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
  CREATE TABLE oauth_identities (provider TEXT NOT NULL, subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY (provider,subject)) STRICT;
  CREATE TABLE reference_blobs (sha256 TEXT PRIMARY KEY CHECK (length(sha256)=64),
    width INTEGER CHECK (width IS NULL OR width > 0),
    height INTEGER CHECK ((width IS NULL AND height IS NULL) OR
      (width IS NOT NULL AND height IS NOT NULL AND height > 0))) STRICT;
  CREATE TABLE reference_images (id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_user_id TEXT,
    name TEXT NOT NULL, media_type TEXT NOT NULL, sha256 TEXT REFERENCES reference_blobs(sha256)) STRICT;
  CREATE INDEX reference_images_sha256 ON reference_images(sha256,id);
  CREATE TABLE generation_clock (id INTEGER PRIMARY KEY CHECK (id=1), epoch INTEGER NOT NULL) STRICT;
  CREATE TABLE creation_requests (owner TEXT NOT NULL, request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
    PRIMARY KEY (owner,request_id)) STRICT;
  CREATE TABLE grid_reference_images (grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE,
    reference_id TEXT NOT NULL, PRIMARY KEY (grid_id,reference_id)) STRICT;
  CREATE INDEX grid_reference_images_reference ON grid_reference_images(reference_id,grid_id);
  CREATE UNIQUE INDEX grids_slug ON grids(slug);
  CREATE INDEX grids_owner_user_created ON grids(owner_user_id,created_at DESC,id);
  CREATE INDEX grids_owner_created ON grids(owner,created_at DESC,id);
  CREATE INDEX grids_visibility_created ON grids(visibility,created_at DESC,id);
  CREATE INDEX sessions_anonymous_created ON sessions(anonymous_id,created_at);
  CREATE TABLE grid_favorites (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE, PRIMARY KEY (user_id,grid_id)) STRICT;
  CREATE INDEX grid_favorites_grid ON grid_favorites(grid_id);
  CREATE TABLE anonymous_grid_favorites (anonymous_id TEXT NOT NULL,
    grid_id TEXT NOT NULL REFERENCES grids(id) ON DELETE CASCADE, PRIMARY KEY (anonymous_id,grid_id)) STRICT;
  CREATE INDEX anonymous_grid_favorites_grid ON anonymous_grid_favorites(grid_id);
  INSERT INTO generation_clock VALUES (1,37);
  PRAGMA user_version=19;
`;

function definition(
  destination: MigrationDestination,
  format = "chat-template",
) {
  return {
    inputVersion: 3,
    format,
    budgetUsd: 1,
    judge: false,
    caseAxes: [],
    rows: [{ id: "row-1" }],
    columns: [{ id: "column-1" }],
    parameters: {
      input: {
        kind: "common",
        value:
          format === "chat-template"
            ? template(destination)
            : [{ role: "user", content: "Preserved accepted prompt" }],
      },
      model: { kind: "common", value: "retired/multimodal" },
      effort: { kind: "common", value: "none" },
    },
  };
}

export type ChatOutputMigrationFixture = {
  directory: string;
  database: string;
  outputs: string;
  secret: Buffer;
  removeSuppliedImage(): () => void;
};

export function chatOutputMigrationFixture(
  t: TestContext,
  options: {
    legacyReferenceFiles?: boolean;
    artifactStatus?: "pending" | "running" | "complete" | "error";
    prefixLength?: number;
  } = {},
): ChatOutputMigrationFixture {
  migrationWorkerEnvironment(t);
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-chat-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, "app.sqlite");
  const outputs = join(directory, "outputs");
  const writeArtifact = (
    id: string,
    name: string,
    content: string | Buffer,
  ) => {
    const path = join(outputs, encodeURIComponent(id), name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  };
  const db = new Database(database);
  try {
    db.pragma("foreign_keys = ON");
    db.exec(version19Schema);
    for (const reference of Object.values(references)) {
      const content = bytes.get(reference.id)!;
      const hash = createHash("sha256").update(content).digest("hex");
      if (options.legacyReferenceFiles) {
        writeArtifact(`reference-${reference.id}`, "image", content);
      } else {
        mkdirSync(join(outputs, ".references"), { recursive: true });
        writeFileSync(join(outputs, ".references", hash), content);
        db.prepare("INSERT INTO reference_blobs VALUES (?,?,?)").run(
          hash,
          reference.width,
          reference.height,
        );
      }
      db.prepare("INSERT INTO reference_images VALUES (?,?,?,?,?,?)").run(
        reference.id,
        "anonymous-owner",
        "account",
        reference.name,
        "image/png",
        options.legacyReferenceFiles ? null : hash,
      );
    }
    const insertGrid = db.prepare(`INSERT INTO grids
      (id,data,owner,owner_user_id,published,visibility,slug,created_at) VALUES (?,?,?,?,?,?,?,?)`);
    const insertTask = db.prepare(`INSERT INTO workflow_tasks
      (id,grid_id,kind,status,artifact_id,thinking_source_id,data) VALUES (?,?,'generation',?,?,?,?)`);
    for (const id of ["source", "destination", "failed", "live", "markdown"]) {
      const destination = id === "destination" ? "destination" : "source";
      const format = id === "markdown" ? "markdown" : "chat-template";
      const status =
        id === "source" || id === "destination"
          ? (options.artifactStatus ?? "complete")
          : id === "failed"
            ? "error"
            : id === "live"
              ? "running"
              : "complete";
      const complete =
        id === "source" || id === "destination" || id === "markdown";
      insertGrid.run(
        id,
        JSON.stringify({
          input: definition(destination, format),
          status:
            status === "error" || status === "pending" ? "paused" : status,
          title: `Saved ${id}`,
          expanded_prompt_for_title: "Preserved title expansion",
        }),
        "anonymous-owner",
        "account",
        id === "source" ? 1 : 0,
        id === "source" ? "public" : "private",
        id === "source" ? "public-example" : null,
        createdAt,
      );
      insertTask.run(
        `task-${id}`,
        id,
        status,
        complete
          ? id === "markdown"
            ? "markdown-artifact"
            : "shared-chat"
          : null,
        "historic-thinking",
        JSON.stringify({
          input: {
            format,
            model: "retired/multimodal",
            effort: "none",
            prompt: "Preserved accepted prompt",
            messages:
              format === "chat-template"
                ? template(destination)
                : [{ role: "user", content: "Preserved accepted prompt" }],
            budgetUsd: 1,
          },
          ...(complete
            ? {
                output: {
                  provenance: {
                    signature: "historic-signature",
                    files: [id === "markdown" ? "index.md" : "messages.json"],
                    templateSteps: [
                      { maxOutputTokens: 99, usage: { costUsd: 0.25 } },
                    ],
                  },
                  usage: { costUsd: 0.25, inputTokens: 10, outputTokens: 20 },
                  thinkingId,
                },
              }
            : {
                attemptId: `${id}-attempt`,
                ...(id === "failed"
                  ? { error: "Historic provider failure" }
                  : {}),
                progress: {
                  draft: JSON.stringify(
                    oldTranscript.slice(0, options.prefixLength ?? 5),
                    null,
                    2,
                  ),
                  thinkingId,
                },
              }),
        }),
      );
      db.prepare(
        `INSERT INTO cells
        (id,grid_id,position,data,generation_id) VALUES (?,?,0,'{}',?)`,
      ).run(`cell-${id}`, id, `task-${id}`);
      for (const reference of Object.values(references))
        db.prepare("INSERT INTO grid_reference_images VALUES (?,?)").run(
          id,
          reference.id,
        );
    }
    db.prepare("INSERT INTO users VALUES ('account',?)").run(
      JSON.stringify({
        provider: "github",
        username: "saved-user",
        profileURL: "https://example.test/user",
      }),
    );
    db.prepare(
      "INSERT INTO sessions VALUES ('browser-session',?,'anonymous-owner',123456)",
    ).run(
      JSON.stringify({
        userId: "account",
        key: encrypt("preserved-browser-key", secret),
        inferenceConcurrency: 3,
      }),
    );
    db.exec(`
      INSERT INTO oauth_identities VALUES ('github','42','account');
      INSERT INTO creation_requests VALUES ('anonymous-owner','request','fingerprint','source');
      INSERT INTO grid_favorites VALUES ('account','source');
      INSERT INTO anonymous_grid_favorites VALUES ('anonymous-owner','source');
    `);
    db.prepare(
      `INSERT INTO inference_calls
      (id,cell_id,started_at,data,attempt_id,phase,status,cost_usd,task_id)
      VALUES ('paid-call','cell-source',100,?,'historic-attempt','direct','succeeded',0.25,'task-source')`,
    ).run(
      JSON.stringify({
        finishedAt: 101,
        generationId: "provider-id",
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    );
    writeArtifact(
      "shared-chat",
      "messages.json",
      JSON.stringify(oldTranscript, null, 2),
    );
    writeArtifact(
      "markdown-artifact",
      "index.md",
      "Unrelated Markdown stays byte-for-byte intact.\n",
    );
    const thinkingDirectory = join(outputs, ".thinking", "historic-thinking");
    mkdirSync(thinkingDirectory, { recursive: true });
    writeFileSync(
      join(thinkingDirectory, `${thinkingId}.txt`),
      "Preserved reasoning trace.",
    );
  } finally {
    db.close();
  }
  return {
    directory,
    database,
    outputs,
    secret,
    removeSuppliedImage() {
      const content = bytes.get(references.wide.id)!;
      const path = options.legacyReferenceFiles
        ? join(outputs, `reference-${references.wide.id}`, "image")
        : join(
            outputs,
            ".references",
            createHash("sha256").update(content).digest("hex"),
          );
      rmSync(path);
      return () => writeFileSync(path, content);
    },
  };
}

export function storedChatTasks(database: string): StoredChatTask[] {
  const db = new Database(database, { readonly: true });
  try {
    return db
      .prepare<[], Omit<StoredChatTask, "data"> & { data: string }>(
        "SELECT id,grid_id,status,artifact_id,thinking_source_id,data FROM workflow_tasks ORDER BY rowid",
      )
      .all()
      .map((row) => ({ ...row, data: JSON.parse(row.data) }));
  } finally {
    db.close();
  }
}

export function chatMigrationDatabaseState(database: string) {
  const db = new Database(database, { readonly: true });
  try {
    const tables = [
      "grids",
      "workflow_tasks",
      "cells",
      "sessions",
      "inference_calls",
      "users",
      "oauth_identities",
      "reference_blobs",
      "reference_images",
      "generation_clock",
      "creation_requests",
      "grid_reference_images",
      "grid_favorites",
      "anonymous_grid_favorites",
    ];
    return {
      version: db.pragma("user_version", { simple: true }) as number,
      foreignKeyViolations: db.pragma("foreign_key_check"),
      tables: Object.fromEntries(
        tables.map((table) => [
          table,
          db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all(),
        ]),
      ),
    };
  } finally {
    db.close();
  }
}

export function failChatArtifactRepoint(database: string) {
  const db = new Database(database);
  try {
    db.exec(`CREATE TRIGGER reject_chat_migration BEFORE UPDATE ON workflow_tasks
      WHEN OLD.id='task-destination' AND NEW.artifact_id IS NOT OLD.artifact_id
      BEGIN SELECT RAISE(ABORT,'fixture rejects canonical artifact repoint'); END;`);
  } finally {
    db.close();
  }
  return () => {
    const db = new Database(database);
    try {
      db.exec("DROP TRIGGER reject_chat_migration");
    } finally {
      db.close();
    }
  };
}

export function outputFileInventory(root: string) {
  const files: {
    path: string;
    sha256: string;
    size: number;
    inode: number;
    modified: number;
  }[] = [];
  function collect(relative: string) {
    for (const entry of readdirSync(join(root, relative), {
      withFileTypes: true,
    })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile()) {
        const stat = statSync(join(root, path));
        files.push({
          path,
          sha256: createHash("sha256")
            .update(readFileSync(join(root, path)))
            .digest("hex"),
          size: stat.size,
          inode: stat.ino,
          modified: stat.mtimeMs,
        });
      }
    }
  }
  collect("");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function corruptInstalledChatReplacement(root: string) {
  const replacement = outputFileInventory(root).find(
    (file) =>
      file.path.endsWith("/messages.json") &&
      !file.path.startsWith("shared-chat/"),
  );
  if (!replacement)
    throw new Error("Expected an installed canonical replacement");
  const path = join(root, replacement.path);
  const original = readFileSync(path);
  writeFileSync(path, "corrupted canonical replacement");
  return () => writeFileSync(path, original);
}

export async function preserveLegacyChatDatabase(
  fixture: ChatOutputMigrationFixture,
) {
  const saved = join(fixture.directory, "legacy.sqlite");
  const db = new Database(fixture.database);
  try {
    await db.backup(saved);
  } finally {
    db.close();
  }
  return () => {
    copyFileSync(saved, fixture.database);
  };
}

export async function killMigrationBeforeArtifactRepoint(
  fixture: ChatOutputMigrationFixture,
) {
  const db = new Database(fixture.database);
  try {
    db.pragma("journal_mode = WAL");
  } finally {
    db.close();
  }
  const source = `
    import { Store } from ${JSON.stringify(new URL("../server/store.ts", import.meta.url).href)};
    import * as inspector from "node:inspector";
    const startup = Promise.withResolvers();
    process.on("disconnect", () => process.exit(0));
    process.on("message", (message) => {
      if (message.inspect) {
        inspector.open(0, "127.0.0.1");
        process.send(inspector.url());
      } else if (message.start) {
        startup.resolve();
      }
    });
    process.send({ ready: true });
    await startup.promise;
    const store = await Store.open(
      ${JSON.stringify(fixture.database)},
      Buffer.from(${JSON.stringify(fixture.secret.toString("hex"))}, "hex"),
      ${JSON.stringify(fixture.outputs)},
      { models: async () => ${JSON.stringify(chatMigrationModels)} },
    );
    store.db.close();
  `;
  const controller = new AbortController();
  let checkpoint: CrashCheckpoint | undefined;
  let expectedKill = false;
  let stderr = "";
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, STARTUP_DATA_MIGRATION_PARALLEL_WORKERS: "30" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = Promise.withResolvers<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  child.once("error", (error) => {
    child.kill("SIGKILL");
    controller.abort(error);
    exited.reject(error);
  });
  child.once("exit", (code, signal) => {
    if (!expectedKill)
      controller.abort(
        new Error(
          `Migration exited before SIGKILL (code ${code}, signal ${signal}): ${stderr}`,
        ),
      );
    exited.resolve({ code, signal });
  });
  const deadline = setTimeout(() => {
    child.kill("SIGKILL");
    controller.abort(
      new Error(`Migration did not reach publication checkpoint: ${stderr}`),
    );
  }, 15000);
  void exited.promise.catch(() => {});
  try {
    const [ready] = await once(child, "message", { signal: controller.signal });
    if (
      !ready ||
      typeof ready !== "object" ||
      !("ready" in ready) ||
      ready.ready !== true
    )
      throw new Error("Migration child did not acknowledge loaded modules");
    checkpoint = await crashCheckpoint(
      child,
      "startup-data-migration.ts",
      "syncPath(outputsPath)",
      undefined,
      controller.signal,
    );
    child.send({ start: true });
    await checkpoint.paused;
    const replacement = outputFileInventory(fixture.outputs).find(
      (file) =>
        file.path.startsWith("canonical-") &&
        file.path.endsWith("/messages.json"),
    );
    if (!replacement)
      throw new Error(
        "Migration checkpoint has no installed canonical artifact",
      );
    const artifactId = replacement.path.split("/")[0]!;
    const messages: CanonicalMessageJSON[] = JSON.parse(
      readFileSync(join(fixture.outputs, replacement.path), "utf8"),
    );
    const source = new Database(fixture.database, { readonly: true });
    let journalMode: string;
    try {
      journalMode = source.pragma("journal_mode", { simple: true }) as string;
    } finally {
      source.close();
    }
    expectedKill = true;
    child.kill("SIGKILL");
    const exit = await exited.promise;
    return { artifactId, journalMode, ...exit, messages };
  } finally {
    clearTimeout(deadline);
    expectedKill = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited.promise.catch(() => {});
    }
    controller.abort();
    checkpoint?.close();
    if (child.connected) child.disconnect();
  }
}
