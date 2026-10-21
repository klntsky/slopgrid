import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { randomBytes, createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  realpathSync,
  constants,
  linkSync,
} from "node:fs";

function check(condition, message) {
  if (!condition) throw new Error(message);
}
const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
function copyTree(source, target) {
  const stat = lstatSync(source);
  check(!stat.isSymbolicLink(), "Refusing an output symlink");
  if (stat.isDirectory()) {
    mkdirSync(target, { mode: 0o700 });
    for (const name of readdirSync(source))
      copyTree(join(source, name), join(target, name));
  } else {
    check(stat.isFile(), "Output is not a regular file");
    copyFileSync(source, target);
    check(hash(source) === hash(target), "Copied output checksum mismatch");
  }
}
function safeId(id) {
  check(/^[a-f0-9]{48}$/.test(id), "Invalid artifact identifier");
}
function safeTaskId(id) {
  check(
    typeof id === "string" && /^[a-zA-Z0-9:_-]{1,256}$/.test(id),
    "Invalid workflow task identifier",
  );
}
function safeFile(name) {
  check(
    typeof name === "string" &&
      /^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(name) &&
      name.split("/").every((part) => part && part !== "." && part !== ".."),
    "Unsafe output path",
  );
}

function artifactPaths(tasks) {
  const paths = new Set();
  for (const task of tasks) {
    if (task.artifact_id) {
      safeId(task.artifact_id);
      paths.add(task.artifact_id);
    }
    if (task.thinking_source_id) {
      safeId(task.thinking_source_id);
      paths.add(join(".thinking", task.thinking_source_id));
    }
  }
  return paths;
}

function inventory(root, relative) {
  let path = root;
  for (const part of relative.split("/")) {
    path = join(path, part);
    if (!existsSync(path)) {
      check(
        !lstatSync(path, { throwIfNoEntry: false }),
        "Refusing an output symlink",
      );
      return undefined;
    }
    check(!lstatSync(path).isSymbolicLink(), "Refusing an output symlink");
  }
  check(lstatSync(path).isDirectory(), "Output is not a directory");
  const files = [];
  const visit = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const stat = lstatSync(file);
      check(!stat.isSymbolicLink(), "Refusing an output symlink");
      if (stat.isDirectory()) {
        files.push([prefix + name + "/", null]);
        visit(file, prefix + name + "/");
      } else {
        check(stat.isFile(), "Output is not a regular file");
        files.push([prefix + name, hash(file)]);
      }
    }
  };
  visit(path, "");
  return JSON.stringify(files);
}

function referenceInventory(root, sha256) {
  check(/^[a-f0-9]{64}$/.test(sha256), "Invalid reference SHA-256");
  const directory = join(root, ".references");
  const parent = lstatSync(directory, { throwIfNoEntry: false });
  if (!parent) return false;
  check(
    !parent.isSymbolicLink() && parent.isDirectory(),
    "Reference storage is not a regular directory",
  );
  const path = join(directory, sha256);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  check(
    !stat.isSymbolicLink() && stat.isFile(),
    "Reference blob is not a regular file",
  );
  check(hash(path) === sha256, "Reference blob checksum mismatch");
  return true;
}

function copyReference(source, target, sha256) {
  const directory = join(target, ".references");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(
    directory,
    `.${sha256}-${randomBytes(12).toString("hex")}`,
  );
  try {
    copyFileSync(
      join(source, ".references", sha256),
      temporary,
      constants.COPYFILE_EXCL,
    );
    check(hash(temporary) === sha256, "Copied reference checksum mismatch");
    try {
      linkSync(temporary, join(directory, sha256));
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      check(
        referenceInventory(target, sha256),
        "Destination reference is missing",
      );
      return false;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

// Target commit precedes source removal. A crash between them leaves both copies,
// and a subsequent run refuses to overwrite the destination.
export function transferGrid(Database, options) {
  const { grid, removeModel, apply = false } = options;
  safeId(grid);
  check(
    realpathSync(options.sourceDb) !== realpathSync(options.targetDb),
    "Databases must differ",
  );
  check(
    realpathSync(options.sourceOutputs) !== realpathSync(options.targetOutputs),
    "Output directories must differ",
  );
  const source = new Database(options.sourceDb, {
    readonly: !apply,
    fileMustExist: true,
    timeout: 5000,
  });
  const target = new Database(options.targetDb, {
    readonly: !apply,
    fileMustExist: true,
    timeout: 5000,
  });
  const copied = [];
  let targetCommitted = false;
  try {
    for (const db of [source, target]) {
      check(
        db.pragma("user_version", { simple: true }) === 17,
        "Grid transfer requires database schema 17",
      );
      db.pragma("foreign_keys=ON");
      db.exec(apply ? "BEGIN IMMEDIATE" : "BEGIN");
    }
    const row = source.prepare("SELECT * FROM grids WHERE id=?").get(grid);
    check(row, "Source grid not found");
    const data = JSON.parse(row.data);
    check(
      data.input?.inputVersion === undefined,
      "Selective grid transfer does not support this grid input version",
    );
    check(
      ["paused", "complete"].includes(data.status) &&
        !row.published &&
        row.visibility === "private",
      "Source grid must be settled and private",
    );
    check(row.owner_user_id, "Source grid requires account ownership");
    check(
      data.input.format === "svg" &&
        data.input.rows.kind === "model" &&
        data.input.columns.values.length === 1,
      "Transfer requires an SVG grid with model rows and one column",
    );
    const positions = data.input.rows.values.flatMap((model, index) =>
      model === removeModel ? [index] : [],
    );
    check(
      positions.length === 1,
      "Removed model must identify exactly one row",
    );
    const cells = source
      .prepare("SELECT * FROM cells WHERE grid_id=? ORDER BY position")
      .all(grid);
    check(
      cells.length === data.input.rows.values.length &&
        cells.every((cell, index) => cell.position === index),
      "Grid positions do not match its inputs",
    );
    for (const cell of cells) safeId(cell.id);
    const tasks = source
      .prepare("SELECT * FROM workflow_tasks WHERE grid_id=? ORDER BY rowid")
      .all(grid);
    for (const task of tasks) safeTaskId(task.id);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const status = (cell) => {
      const generation = byId.get(cell.generation_id);
      const judgment = cell.judgment_id
        ? byId.get(cell.judgment_id)
        : undefined;
      check(generation?.kind === "generation", "Invalid generation task link");
      check(
        !cell.judgment_id ||
          (judgment?.kind === "judge" &&
            judgment.dependency_id === generation.id),
        "Invalid judgment task link",
      );
      return generation.status === "complete"
        ? (judgment?.status ?? generation.status)
        : generation.status;
    };
    const removed = cells[positions[0]];
    check(status(removed) === "error", "Removed cell must be failed");
    const retained = cells.filter((cell) => cell.id !== removed.id);
    check(
      retained.length && retained.every((cell) => status(cell) === "complete"),
      "Retained cells must be complete",
    );
    const retainedIds = new Set(
      retained.flatMap((cell) =>
        [cell.generation_id, cell.judgment_id].filter(Boolean),
      ),
    );
    const retainedTasks = tasks.filter((task) => retainedIds.has(task.id));
    for (const task of tasks) {
      check(
        !source
          .prepare(
            "SELECT 1 FROM cells WHERE grid_id!=? AND (generation_id=? OR judgment_id=?)",
          )
          .get(grid, task.id, task.id) &&
          !source
            .prepare(
              "SELECT 1 FROM workflow_tasks WHERE grid_id!=? AND dependency_id=?",
            )
            .get(grid, task.id) &&
          !source
            .prepare(
              "SELECT 1 FROM inference_calls i JOIN cells c ON c.id=i.cell_id WHERE c.grid_id!=? AND i.task_id=?",
            )
            .get(grid, task.id),
        "Source task has references outside its grid",
      );
    }
    const calls = source
      .prepare(
        "SELECT i.* FROM inference_calls i JOIN cells c ON c.id=i.cell_id WHERE c.grid_id=? ORDER BY i.started_at,i.id",
      )
      .all(grid);
    check(
      calls.every((call) => call.status !== "running"),
      "Source grid has unsettled calls",
    );
    check(
      calls.every((call) => byId.has(call.task_id)),
      "Invalid inference task link",
    );
    const retainedCalls = calls
      .filter((call) => retainedIds.has(call.task_id))
      .map((call) => {
        if (retained.some((cell) => cell.id === call.cell_id)) return call;
        const attribution = retained.find(
          (cell) =>
            cell.generation_id === call.task_id ||
            cell.judgment_id === call.task_id,
        );
        check(attribution, "Retained call has no destination cell");
        return { ...call, cell_id: attribution.id };
      });
    const identities = source
      .prepare("SELECT provider,subject FROM oauth_identities WHERE user_id=?")
      .all(row.owner_user_id);
    const owners = new Set(
      identities.flatMap((identity) =>
        target
          .prepare(
            "SELECT user_id FROM oauth_identities WHERE provider=? AND subject=?",
          )
          .all(identity.provider, identity.subject)
          .map((identity) => identity.user_id),
      ),
    );
    check(
      owners.size === 1,
      "A unique matching destination account is required",
    );
    const owner = [...owners][0];
    check(
      target.prepare("SELECT 1 FROM users WHERE id=?").get(owner),
      "Destination account is missing",
    );
    check(
      !target.prepare("SELECT 1 FROM grids WHERE id=?").get(grid),
      "Destination grid already exists",
    );
    for (const cell of retained) {
      safeId(cell.id);
      check(
        !target.prepare("SELECT 1 FROM cells WHERE id=?").get(cell.id),
        "Destination cell already exists",
      );
    }
    for (const task of retainedTasks) {
      check(
        !target.prepare("SELECT 1 FROM workflow_tasks WHERE id=?").get(task.id),
        "Destination task already exists",
      );
      if (task.kind !== "generation") continue;
      const metadata = JSON.parse(task.data);
      check(
        task.artifact_id && metadata.output?.provenance?.files?.length,
        "Output inventory is missing",
      );
      for (const name of metadata.output.provenance.files) {
        safeFile(name);
        check(
          existsSync(join(options.sourceOutputs, task.artifact_id, name)),
          "Source output is missing",
        );
      }
      if (metadata.output.thinkingId) {
        safeId(metadata.output.thinkingId);
        check(
          task.thinking_source_id &&
            existsSync(
              join(
                options.sourceOutputs,
                ".thinking",
                task.thinking_source_id,
                metadata.output.thinkingId + ".txt",
              ),
            ),
          "Source thinking is missing",
        );
      }
    }
    const paths = artifactPaths(tasks);
    const retainedPaths = artifactPaths(retainedTasks);
    const toCopy = new Set();
    for (const relative of paths) {
      const original = inventory(options.sourceOutputs, relative);
      if (!retainedPaths.has(relative)) continue;
      check(original !== undefined, "Source output is missing");
      const existing = inventory(options.targetOutputs, relative);
      check(
        existing === undefined || existing === original,
        "Destination output already exists with different contents",
      );
      if (existing === undefined) toCopy.add(relative);
    }
    const references = source
      .prepare("SELECT reference_id FROM grid_reference_images WHERE grid_id=?")
      .all(grid);
    const referenceImages = source
      .prepare(
        `SELECT r.* FROM reference_images r
        JOIN grid_reference_images g ON g.reference_id=r.id
        WHERE g.grid_id=? ORDER BY r.id`,
      )
      .all(grid);
    const findReference = target.prepare(
      "SELECT owner_user_id,name,media_type,sha256 FROM reference_images WHERE id=?",
    );
    const newReferenceImages = referenceImages.filter((reference) => {
      const existing = findReference.get(reference.id);
      if (!existing) return true;
      check(
        existing.owner_user_id === owner &&
          existing.name === reference.name &&
          existing.media_type === reference.media_type &&
          existing.sha256 === reference.sha256,
        "Destination reference metadata already exists with different contents or ownership",
      );
      return false;
    });
    const referenceBlobs = new Map();
    const findSourceBlob = source.prepare(
      "SELECT sha256,width,height FROM reference_blobs WHERE sha256=?",
    );
    const findTargetBlob = target.prepare(
      "SELECT width,height FROM reference_blobs WHERE sha256=?",
    );
    for (const reference of referenceImages) {
      if (reference.sha256 === null || referenceBlobs.has(reference.sha256))
        continue;
      const blob = findSourceBlob.get(reference.sha256);
      check(blob, "Source reference blob metadata is missing");
      const targetBlob = findTargetBlob.get(reference.sha256);
      check(
        !targetBlob ||
          blob.width === null ||
          targetBlob.width === null ||
          (targetBlob.width === blob.width &&
            targetBlob.height === blob.height),
        "Destination reference blob dimensions already exist with different contents",
      );
      const available = referenceInventory(
        options.sourceOutputs,
        reference.sha256,
      );
      const existing = referenceInventory(
        options.targetOutputs,
        reference.sha256,
      );
      referenceBlobs.set(reference.sha256, { blob, available, existing });
    }
    for (const call of retainedCalls)
      check(
        !target
          .prepare("SELECT 1 FROM inference_calls WHERE id=?")
          .get(call.id),
        "Destination call already exists",
      );
    const summary = {
      grid,
      removedModel: removeModel,
      retainedCells: retained.length,
      retainedTasks: retainedTasks.length,
      retainedCalls: retainedCalls.length,
      visibility: "private",
    };
    if (!apply) return summary;
    check(
      options.backupDir && !existsSync(options.backupDir),
      "A new backup directory is required",
    );
    mkdirSync(options.backupDir, { recursive: true, mode: 0o700 });
    const receipts = source
      .prepare("SELECT * FROM creation_requests WHERE grid_id=?")
      .all(grid);
    writeFileSync(
      join(options.backupDir, "source.json"),
      JSON.stringify({
        grid: row,
        cells,
        tasks,
        calls,
        receipts,
        references,
        referenceImages,
        referenceBlobs: [...referenceBlobs.values()].map(({ blob }) => blob),
      }),
      { mode: 0o600 },
    );
    for (const relative of paths) {
      const from = join(options.sourceOutputs, relative);
      if (!existsSync(from)) continue;
      const backup = join(options.backupDir, "outputs", relative);
      mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
      copyTree(from, backup);
      if (!toCopy.has(relative)) continue;
      const to = join(options.targetOutputs, relative);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      copied.push(to);
      copyTree(from, to);
    }
    for (const [sha256, { available, existing }] of referenceBlobs) {
      if (!available) continue;
      const backup = join(options.backupDir, "outputs", ".references", sha256);
      mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
      copyFileSync(
        join(options.sourceOutputs, ".references", sha256),
        backup,
        constants.COPYFILE_EXCL,
      );
      check(hash(backup) === sha256, "Backed-up reference checksum mismatch");
      if (
        !existing &&
        copyReference(options.sourceOutputs, options.targetOutputs, sha256)
      )
        copied.push(join(options.targetOutputs, ".references", sha256));
    }
    data.status = "complete";
    delete data.interruption;
    data.input.rows.values.splice(positions[0], 1);
    target
      .prepare(
        `INSERT INTO grids
      (id,data,owner,owner_user_id,published,visibility,slug,created_at)
      VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        grid,
        JSON.stringify(data),
        randomBytes(24).toString("hex"),
        owner,
        row.published,
        row.visibility,
        row.slug,
        row.created_at,
      );
    const addBlob = target.prepare(
      `INSERT INTO reference_blobs (sha256,width,height) VALUES (?,?,?)
      ON CONFLICT (sha256) DO UPDATE SET width=excluded.width,height=excluded.height
      WHERE reference_blobs.width IS NULL AND excluded.width IS NOT NULL`,
    );
    for (const { blob } of referenceBlobs.values())
      addBlob.run(blob.sha256, blob.width, blob.height);
    const addReferenceImage = target.prepare(
      `INSERT INTO reference_images
      (id,owner,owner_user_id,name,media_type,sha256) VALUES (?,?,?,?,?,?)`,
    );
    for (const reference of newReferenceImages)
      addReferenceImage.run(
        reference.id,
        randomBytes(24).toString("hex"),
        owner,
        reference.name,
        reference.media_type,
        reference.sha256,
      );
    const addReference = target.prepare(
      "INSERT INTO grid_reference_images (grid_id,reference_id) VALUES (?,?)",
    );
    for (const reference of references)
      addReference.run(grid, reference.reference_id);
    const addTask = target.prepare(
      `INSERT INTO workflow_tasks
      (id,grid_id,kind,status,dependency_id,artifact_id,thinking_source_id,data)
      VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (const kind of ["generation", "judge"])
      for (const task of retainedTasks.filter((task) => task.kind === kind))
        addTask.run(
          task.id,
          grid,
          task.kind,
          task.status,
          task.dependency_id,
          task.artifact_id,
          task.thinking_source_id,
          task.data,
        );
    retained.forEach((cell, position) =>
      target
        .prepare(
          "INSERT INTO cells (id,grid_id,position,data,generation_id,judgment_id) VALUES (?,?,?,'{}',?,?)",
        )
        .run(cell.id, grid, position, cell.generation_id, cell.judgment_id),
    );
    for (const call of retainedCalls)
      target
        .prepare(
          `INSERT INTO inference_calls
        (id,cell_id,started_at,data,attempt_id,phase,status,cost_usd,task_id)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          call.id,
          call.cell_id,
          call.started_at,
          call.data,
          call.attempt_id,
          call.phase,
          call.status,
          call.cost_usd,
          call.task_id,
        );
    check(
      target.prepare("SELECT count(*) n FROM cells WHERE grid_id=?").get(grid)
        .n === retained.length,
      "Destination cell count mismatch",
    );
    target.exec("COMMIT");
    targetCommitted = true;
    source
      .prepare(
        "DELETE FROM inference_calls WHERE cell_id IN (SELECT id FROM cells WHERE grid_id=?)",
      )
      .run(grid);
    source.prepare("DELETE FROM creation_requests WHERE grid_id=?").run(grid);
    source.prepare("DELETE FROM cells WHERE grid_id=?").run(grid);
    source.prepare("DELETE FROM workflow_tasks WHERE grid_id=?").run(grid);
    source.prepare("DELETE FROM grids WHERE id=?").run(grid);
    source.exec("COMMIT");
    for (const relative of paths) {
      const thinking = relative.startsWith(".thinking/");
      const id = thinking ? relative.slice(".thinking/".length) : relative;
      const column = thinking ? "thinking_source_id" : "artifact_id";
      if (
        !source
          .prepare(`SELECT 1 FROM workflow_tasks WHERE ${column}=?`)
          .get(id)
      )
        rmSync(join(options.sourceOutputs, relative), {
          recursive: true,
          force: true,
        });
    }
    return { ...summary, moved: true, backup: options.backupDir };
  } finally {
    for (const db of [source, target]) {
      if (db.inTransaction) db.exec("ROLLBACK");
      db.close();
    }
    if (!targetCommitted)
      for (const path of copied) rmSync(path, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const names = [
      "source-db",
      "target-db",
      "source-outputs",
      "target-outputs",
      "grid",
      "remove-model",
      "backup-dir",
      "app",
    ];
    const { values } = parseArgs({
      options: {
        ...Object.fromEntries(names.map((name) => [name, { type: "string" }])),
        apply: { type: "boolean", default: false },
      },
    });
    for (const name of names) check(values[name], `Missing --${name}`);
    const options = Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()),
        value,
      ]),
    );
    const Database = createRequire(join(resolve(options.app), "package.json"))(
      "better-sqlite3",
    );
    console.log(JSON.stringify(transferGrid(Database, options)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
