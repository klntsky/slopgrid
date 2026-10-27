import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseEnv } from "node:util";

const overlaps = (a, b) =>
  a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
const inode = (stat) => `${stat.dev}:${stat.ino}`;
const identity = (stat) =>
  `${inode(stat)}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const inspect = (path) => lstatSync(path, { bigint: true, throwIfNoEntry: false });

function storagePath(path) {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("Production data copying requires absolute storage paths");
  const normalized = resolve(path);
  let current = sep;
  const parts = normalized.slice(1).split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const stat = inspect(current);
    if (!stat) break;
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()))
      throw new Error("Production data copying rejects symlinked storage paths");
  }
  return normalized;
}

function regular(path, kind, optional = false) {
  const stat = inspect(path);
  if (!stat && optional) return undefined;
  if (!stat || !(kind === "directory" ? stat.isDirectory() : stat.isFile()))
    throw new Error(`Production data copying requires a regular ${kind}`);
  if (stat.isFile() && stat.nlink !== 1n)
    throw new Error("Production data copying rejects hardlinked storage files");
  return stat;
}

function inspectTree(path, files, optional = false) {
  const stat = inspect(path);
  if (!stat && optional) return;
  if (stat?.isDirectory()) {
    files.add(inode(stat));
    for (const name of readdirSync(path)) inspectTree(join(path, name), files);
  } else {
    files.add(inode(regular(path, "file")));
  }
}

function assertStorage(paths) {
  const names = Object.keys(paths);
  for (const name of names) storagePath(paths[name]);
  for (let index = 0; index < names.length; index++)
    for (let other = index + 1; other < names.length; other++)
      if (overlaps(paths[names[index]], paths[names[other]]))
        throw new Error("Production and staging storage paths must not overlap");
  regular(paths.sourceDatabase, "file");
  regular(paths.sourceOutputs, "directory");
  regular(paths.database, "file", true);
  regular(paths.outputs, "directory", true);
  regular(paths.env, "file");
  regular(paths.run, "directory");
  const source = new Set();
  inspectTree(paths.sourceDatabase, source);
  inspectTree(paths.sourceOutputs, source);
  const destination = new Set();
  inspectTree(paths.database, destination, true);
  inspectTree(paths.outputs, destination, true);
  inspectTree(paths.env, destination);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const from = storagePath(paths.sourceDatabase + suffix);
    const to = storagePath(paths.database + suffix);
    for (const path of [from, to]) {
      for (const name of names)
        if (overlaps(path, paths[name]))
          throw new Error("SQLite sidecars must not overlap staging or production storage");
      regular(path, "file", true);
    }
    inspectTree(from, source, true);
    inspectTree(to, destination, true);
  }
  for (const value of destination)
    if (source.has(value))
      throw new Error("Production and staging storage must not share file identities");
}

function copyOutputs(source, destination) {
  const buffer = Buffer.allocUnsafe(65536);
  function copy(from, to) {
    const before = inspect(from);
    if (before?.isDirectory()) {
      mkdirSync(to, { mode: 0o700 });
      for (const name of readdirSync(from)) copy(join(from, name), join(to, name));
      if (inode(regular(from, "directory")) !== inode(before))
        throw new Error("Production output directory changed during copying");
      return;
    }
    regular(from, "file");
    const input = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
    let output;
    try {
      if (identity(before) !== identity(fstatSync(input, { bigint: true })))
        throw new Error("Production output changed during copying");
      output = openSync(to, "wx", 0o600);
      let count;
      while ((count = readSync(input, buffer, 0, buffer.length, null))) {
        let offset = 0;
        while (offset < count)
          offset += writeSync(output, buffer, offset, count - offset);
      }
      if (
        identity(before) !== identity(regular(from, "file")) ||
        identity(before) !== identity(fstatSync(input, { bigint: true }))
      )
        throw new Error("Production output changed during copying");
    } finally {
      closeSync(input);
      if (output !== undefined) closeSync(output);
    }
  }
  copy(source, destination);
}

function replacementEnvironment(original, key) {
  let found = false;
  const updated = original.replace(
    /(^[\t ]*(?:export[\t ]+)?([A-Za-z_][A-Za-z0-9_]*)[\t ]*=[\t ]*)('[^']*'|"[^"]*"|`[^`]*`|[^\r\n]*)([^\r\n]*)/gm,
    (assignment, prefix, name, value, suffix) => {
      if (name !== "KEY_ENCRYPTION_SECRET") return assignment;
      found = true;
      if (["'", '"', "`"].includes(value[0]))
        return prefix + value[0] + key + value[0] + suffix;
      const trailing = value.match(/[\t ]*(?:#.*)?$/)?.[0] ?? "";
      return prefix + key + trailing + suffix;
    },
  );
  const result = found
    ? updated
    : original + (original.endsWith("\n") || !original ? "" : "\n") + `KEY_ENCRYPTION_SECRET=${key}\n`;
  if (
    !isDeepStrictEqual(parseEnv(result), {
      ...parseEnv(original),
      KEY_ENCRYPTION_SECRET: key,
    })
  )
    throw new Error("Cannot update staging encryption key without changing configuration");
  return result;
}

function initializeCopy(release, scratch, key, providerBaseURL) {
  const require = createRequire(join(release, "package.json"));
  const loader = pathToFileURL(require.resolve("tsx/esm")).href;
  const program = `
    import { Store } from './server/store.ts';
    import { schemaVersion } from './server/database.ts';
    import { recoverInterruptedGrids } from './server/recovery.ts';
    let store;
    try {
      if (!Number.isSafeInteger(schemaVersion) || schemaVersion <= 0)
        throw new Error('invalid candidate schema');
      store = await Store.open(process.env.DATABASE_PATH, Buffer.from(process.env.KEY_ENCRYPTION_SECRET, 'hex'), process.env.OUTPUTS_PATH, {
        models: async () => {
          const { Provider } = await import('./server/provider.ts');
          return new Provider(process.env.OPENROUTER_BASE_URL).models();
        },
      });
      recoverInterruptedGrids(store);
      if (store.db.pragma('user_version', { simple: true }) !== schemaVersion)
        throw new Error('candidate schema mismatch');
      if (store.db.prepare("SELECT 1 FROM grids WHERE json_extract(data,'$.input.inputVersion') IS NOT 3 LIMIT 1").get())
        throw new Error('noncanonical grid inputs');
      for (const row of store.db.prepare('SELECT id FROM sessions').all()) store.session(row.id);
      const integrity = store.db.pragma('integrity_check');
      if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok' || store.db.pragma('foreign_key_check').length)
        throw new Error('invalid database');
      store.db.pragma('wal_checkpoint(TRUNCATE)');
      if (store.db.pragma('journal_mode = DELETE', { simple: true }) !== 'delete')
        throw new Error('database checkpoint failed');
    } catch {
      process.exitCode = 42;
    } finally {
      if (store) { try { store.db.close(); } catch { process.exitCode = 42; } }
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", loader, "--input-type=module", "--eval", program],
    {
      cwd: release,
      env: {
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
        NODE_ENV: "production",
        STARTUP_DATA_MIGRATION_PARALLEL_WORKERS: "30",
        ...(providerBaseURL === undefined ? {} : { OPENROUTER_BASE_URL: providerBaseURL }),
        DATABASE_PATH: join(scratch, "slopgrid.sqlite"),
        OUTPUTS_PATH: join(scratch, "outputs"),
        KEY_ENCRYPTION_SECRET: key,
      },
      stdio: "ignore",
      timeout: 300000,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error("Production data copy failed candidate migration, recovery or credential validation");
}

export async function copyProductionData(target, release, stagingEnv, productionEnv, run) {
  const key = productionEnv.KEY_ENCRYPTION_SECRET;
  if (!/^[a-fA-F0-9]{64}$/.test(key ?? ""))
    throw new Error("Production data copying requires a valid encryption key");
  const paths = {
    sourceDatabase: storagePath(productionEnv.DATABASE_PATH),
    sourceOutputs: storagePath(productionEnv.OUTPUTS_PATH),
    database: storagePath(stagingEnv.DATABASE_PATH),
    outputs: storagePath(stagingEnv.OUTPUTS_PATH),
    env: storagePath(target.envFile),
    run: storagePath(run),
  };
  assertStorage(paths);
  const envIdentity = identity(regular(paths.env, "file"));
  const originalEnv = readFileSync(paths.env, "utf8");
  const nextEnv = replacementEnvironment(originalEnv, key);
  const scratch = mkdtempSync(join(paths.run, "staging-data-"));
  chmodSync(scratch, 0o700);
  let envScratch;
  try {
    const Database = createRequire(join(release, "package.json"))("better-sqlite3");
    const sourceIdentity = inode(regular(paths.sourceDatabase, "file"));
    const database = new Database(paths.sourceDatabase, { readonly: true, fileMustExist: true });
    try {
      await database.backup(join(scratch, "slopgrid.sqlite"));
    } finally {
      database.close();
    }
    if (inode(regular(paths.sourceDatabase, "file")) !== sourceIdentity)
      throw new Error("Production database changed identity during copying");
    chmodSync(join(scratch, "slopgrid.sqlite"), 0o600);
    // SQLite and outputs are separate snapshots, not an atomic cross-storage pair.
    copyOutputs(paths.sourceOutputs, join(scratch, "outputs"));
    const snapshot = new Database(join(scratch, "slopgrid.sqlite"), { readonly: true, fileMustExist: true });
    try {
      const version = snapshot.pragma("user_version", { simple: true });
      if (version === 0)
        throw new Error("Production data copying requires an initialized database");
      if (
        version !== 14 &&
        snapshot.prepare("SELECT 1 FROM grids WHERE json_extract(data,'$.input.inputVersion') IS NOT 3 LIMIT 1").get()
      )
        throw new Error("Production data copying requires canonical inputVersion 3 grids");
    } finally {
      snapshot.close();
    }
    initializeCopy(release, scratch, key, stagingEnv.OPENROUTER_BASE_URL);
    regular(join(scratch, "slopgrid.sqlite"), "file");
    inspectTree(join(scratch, "outputs"), new Set());
    assertStorage(paths);
    if (
      identity(regular(paths.env, "file")) !== envIdentity ||
      readFileSync(paths.env, "utf8") !== originalEnv
    )
      throw new Error("Staging configuration changed during production data copying");
    envScratch = mkdtempSync(join(dirname(paths.env), ".staging-data-env-"));
    chmodSync(envScratch, 0o700);
    const envReplacement = join(envScratch, "runtime.env");
    writeFileSync(envReplacement, nextEnv, { flag: "wx", mode: 0o600 });
    mkdirSync(dirname(paths.database), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(paths.outputs), { recursive: true, mode: 0o700 });
    // Caller has drained/stopped staging and backed it up. Installation failures
    // are fenced by the pipeline; these separate replacements are not a rollback.
    for (const suffix of ["-wal", "-shm", "-journal"])
      rmSync(paths.database + suffix, { force: true });
    copyFileSync(join(scratch, "slopgrid.sqlite"), paths.database);
    chmodSync(paths.database, 0o600);
    rmSync(paths.outputs, { recursive: true, force: true });
    copyOutputs(join(scratch, "outputs"), paths.outputs);
    renameSync(envReplacement, paths.env);
    return { ...stagingEnv, KEY_ENCRYPTION_SECRET: key };
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); }
    finally { if (envScratch) rmSync(envScratch, { recursive: true, force: true }); }
  }
}
