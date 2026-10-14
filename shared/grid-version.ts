type GridVersion = { revision: number; draftRevision?: number };

// Durable mutations supersede all drafts from the preceding revision.
export function compareGridVersions(a: GridVersion, b: GridVersion): number {
  return (
    a.revision - b.revision || (a.draftRevision ?? 0) - (b.draftRevision ?? 0)
  );
}
