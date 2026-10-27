import { OutputFiles } from "./files.js";

export class MigrationOutputFiles extends OutputFiles {
  private readonly source: OutputFiles;
  constructor(root: string, sourceRoot: string) {
    super(root);
    this.source = new OutputFiles(sourceRoot);
  }
  override path(id: string, path: string): string | undefined {
    return super.path(id, path) ?? this.source.path(id, path);
  }
  override referencePath(sha256: string): string | undefined {
    return super.referencePath(sha256) ?? this.source.referencePath(sha256);
  }
}
