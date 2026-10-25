import {
  existsSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  linkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { readdir, readFile, access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";

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
  constructor(
    readonly root: string,
    private readonly referenced: (id: string) => boolean = () => false,
  ) {
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
    if (existsSync(target)) throw new Error("Output artifact already exists");
    const temporary = mkdtempSync(join(this.root, ".pending-"));
    let installed = false;
    try {
      for (const [path, content] of Object.entries(files)) {
        const parts = path.split("/");
        parts.pop();
        mkdirSync(join(temporary, ...parts), { recursive: true, mode: 0o700 });
        writeFileSync(join(temporary, path), content, { mode: 0o600 });
      }
      renameSync(temporary, target);
      installed = true;
    } finally {
      if (!installed) rmSync(temporary, { recursive: true, force: true });
    }
  }
  writeImmutable(files: Record<string, string | Uint8Array>): string {
    const paths = Object.keys(files).sort();
    if (!paths.length || paths.some((path) => !safePath(path)))
      throw new Error("Output files need safe relative paths");
    const hash = createHash("sha256");
    for (const path of paths) {
      const content = files[path];
      const bytes =
        typeof content === "string" ? Buffer.from(content) : content;
      hash.update(JSON.stringify([path, bytes.byteLength]));
      hash.update(bytes);
    }
    const id = `canonical-${hash.digest("hex")}`;
    const directory = this.directory(id);
    if (!existsSync(directory)) {
      this.write(id, files);
      return id;
    }
    const installed: string[] = [];
    const collect = (relative: string) => {
      for (const entry of readdirSync(join(directory, relative), {
        withFileTypes: true,
      })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) collect(path);
        else if (entry.isFile()) installed.push(path);
        else throw new Error("Canonical artifact contains an unexpected entry");
      }
    };
    collect("");
    if (JSON.stringify(installed.sort()) !== JSON.stringify(paths))
      throw new Error("Canonical artifact inventory does not match");
    for (const path of paths) {
      const content = files[path];
      const expected =
        typeof content === "string" ? Buffer.from(content) : content;
      if (!readFileSync(join(directory, path)).equals(expected))
        throw new Error("Canonical artifact content does not match");
    }
    return id;
  }
  writeReference(sha256: string, data: Uint8Array) {
    if (!/^[a-f0-9]{64}$/.test(sha256))
      throw new Error("Invalid reference hash");
    const directory = join(this.root, ".references");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, sha256);
    if (existsSync(target)) return;
    const temporary = mkdtempSync(join(this.root, ".pending-"));
    try {
      const source = join(temporary, "image");
      writeFileSync(source, data, { mode: 0o600 });
      try {
        // Hard-link installation never replaces a concurrent upload's blob.
        linkSync(source, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  referencePath(sha256: string): string | undefined {
    if (!/^[a-f0-9]{64}$/.test(sha256)) return;
    const file = join(this.root, ".references", sha256);
    return existsSync(file) && statSync(file).isFile() ? file : undefined;
  }
  path(id: string, path: string): string | undefined {
    if (!safePath(path)) return;
    const file = join(this.directory(id), path);
    return existsSync(file) && statSync(file).isFile() ? file : undefined;
  }
  private thinkingFile(sourceId: string, id: string): string | undefined {
    if (!/^[a-f0-9]{48}$/.test(id)) return;
    return join(
      this.root,
      ".thinking",
      encodeURIComponent(sourceId),
      id + ".txt",
    );
  }
  appendThinking(sourceId: string, id: string, text: string) {
    const file = this.thinkingFile(sourceId, id);
    if (!file) throw new Error("Invalid thinking ID");
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, text, { mode: 0o600 });
  }
  writeThinking(sourceId: string, id: string, text: string) {
    const file = this.thinkingFile(sourceId, id);
    if (!file) throw new Error("Invalid thinking ID");
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + ".pending";
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, file);
  }
  thinkingPath(sourceId: string, id: string): string | undefined {
    const file = this.thinkingFile(sourceId, id);
    return file && existsSync(file) ? file : undefined;
  }
  async hasArtifact(
    id: string,
    inventory: readonly string[],
    thinkingId?: string,
    thinkingSourceId?: string,
  ): Promise<boolean> {
    if (!inventory.length || inventory.some((path) => !safePath(path)))
      return false;
    try {
      const paths = inventory.map((path) => join(this.directory(id), path));
      if (thinkingId) {
        if (!thinkingSourceId) return false;
        const thinking = this.thinkingFile(thinkingSourceId, thinkingId);
        if (!thinking) return false;
        paths.push(thinking);
      }
      for (const path of paths) {
        if (!(await stat(path)).isFile()) return false;
        await access(path, constants.R_OK);
      }
      return true;
    } catch {
      return false;
    }
  }
  async readArtifact(
    id: string,
    inventory: readonly string[],
    thinkingId?: string,
    thinkingSourceId?: string,
  ): Promise<ArtifactBundle | undefined> {
    // Missing or unreadable content remains an unavailable artifact.
    try {
      if (!inventory.length || inventory.some((path) => !safePath(path)))
        return;
      const files: ArtifactBundle["files"] = Object.create(null);
      for (const path of inventory)
        files[path] = await readFile(join(this.directory(id), path));
      if (!thinkingId) return { files };
      if (!thinkingSourceId) return;
      const thinking = this.thinkingFile(thinkingSourceId, thinkingId);
      if (!thinking) return;
      return { files, thinking: await readFile(thinking) };
    } catch {
      return;
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

  removeArtifact(id: string): boolean {
    if (this.referenced(id)) return false;
    rmSync(this.directory(id), { recursive: true, force: true });
    rmSync(join(this.root, ".thinking", encodeURIComponent(id)), {
      recursive: true,
      force: true,
    });
    return true;
  }
}
