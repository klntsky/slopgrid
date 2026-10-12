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
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";

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
  appendThinking(cellId: string, id: string, text: string) {
    if (!/^[a-f0-9]{48}$/.test(id)) throw new Error("Invalid thinking ID");
    const directory = join(this.root, ".thinking", encodeURIComponent(cellId));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(join(directory, id + ".txt"), text, { mode: 0o600 });
  }
  thinkingPath(cellId: string, id: string): string | undefined {
    if (!/^[a-f0-9]{48}$/.test(id)) return;
    const file = join(
      this.root,
      ".thinking",
      encodeURIComponent(cellId),
      id + ".txt",
    );
    return existsSync(file) ? file : undefined;
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
}
