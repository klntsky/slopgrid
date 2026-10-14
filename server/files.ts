import {
  existsSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import {
  readdir,
  readFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { token } from "./ids.js";

export type ArtifactBundle = {
  files: Record<string, Uint8Array>;
  thinking?: Uint8Array;
};

export function safePath(path: string): boolean {
  return (
    /^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(path) &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}
export class OutputFiles {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  private directory(id: string): string {
    if (!id || id === "." || id === "..") throw new Error("Invalid output ID");
    return join(this.root, encodeURIComponent(id));
  }
  write(id: string, files: Record<string, string | Uint8Array>) {
    if (
      !Object.keys(files).length ||
      Object.keys(files).some((path) => !safePath(path))
    )
      throw new Error("Output files need safe relative paths");
    const target = this.directory(id);
    const temporary = mkdtempSync(join(this.root, ".pending-"));
    try {
      for (const [path, content] of Object.entries(files)) {
        const parts = path.split("/");
        parts.pop();
        mkdirSync(join(temporary, ...parts), { recursive: true, mode: 0o700 });
        writeFileSync(join(temporary, path), content, { mode: 0o600 });
      }
      // A retry may replace files left by a crash before SQLite marked completion.
      rmSync(target, { recursive: true, force: true });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  path(id: string, path: string): string | undefined {
    if (!safePath(path)) return;
    const file = join(this.directory(id), path);
    return existsSync(file) && statSync(file).isFile() ? file : undefined;
  }
  private thinkingFile(cellId: string, id: string): string | undefined {
    if (!/^[a-f0-9]{48}$/.test(id)) return;
    return join(
      this.root,
      ".thinking",
      encodeURIComponent(cellId),
      id + ".txt",
    );
  }
  appendThinking(cellId: string, id: string, text: string) {
    const file = this.thinkingFile(cellId, id);
    if (!file) throw new Error("Invalid thinking ID");
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, text, { mode: 0o600 });
  }
  thinkingPath(cellId: string, id: string): string | undefined {
    const file = this.thinkingFile(cellId, id);
    return file && existsSync(file) ? file : undefined;
  }
  async readArtifact(
    id: string,
    inventory: readonly string[],
    thinkingId?: string,
  ): Promise<ArtifactBundle | undefined> {
    // Validate and read the complete source before any destination is written.
    // Source read failures are misses; destination failures remain ordinary errors.
    try {
      if (!inventory.length || inventory.some((path) => !safePath(path)))
        return;
      const files: ArtifactBundle["files"] = Object.create(null);
      for (const path of inventory)
        files[path] = await readFile(join(this.directory(id), path));
      if (!thinkingId) return { files };
      const thinking = this.thinkingFile(id, thinkingId);
      if (!thinking) return;
      return { files, thinking: await readFile(thinking) };
    } catch {
      return;
    }
  }
  async writeArtifact(
    id: string,
    bundle: ArtifactBundle,
  ): Promise<string | undefined> {
    if (
      !Object.keys(bundle.files).length ||
      Object.keys(bundle.files).some((path) => !safePath(path))
    )
      throw new Error("Output files need safe relative paths");
    const temporary = await mkdtemp(join(this.root, ".pending-"));
    try {
      for (const [path, content] of Object.entries(bundle.files)) {
        const file = join(temporary, path);
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, content, { mode: 0o600 });
      }
      await rename(temporary, this.directory(id));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    if (bundle.thinking !== undefined) {
      const thinkingId = token();
      const file = this.thinkingFile(id, thinkingId)!;
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, bundle.thinking, { mode: 0o600 });
      return thinkingId;
    }
  }
  async bundle(id: string): Promise<Record<string, Uint8Array>> {
    const directory = this.directory(id);
    const files: Record<string, Uint8Array> = Object.create(null);
    async function collect(relative: string) {
      for (const entry of await readdir(join(directory, relative), {
        withFileTypes: true,
      })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (!safePath(path)) continue;
        if (entry.isDirectory()) await collect(path);
        else if (entry.isFile())
          files[path] = await readFile(join(directory, path));
      }
    }
    await collect("");
    return files;
  }

  async removeArtifact(id: string) {
    await rm(this.directory(id), { recursive: true, force: true });
    await rm(join(this.root, ".thinking", encodeURIComponent(id)), {
      recursive: true,
      force: true,
    });
  }
}
