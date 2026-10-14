export type GridVersion = { epoch: number; sequence: number };

// Every snapshot from a replacement engine supersedes its predecessor's reads.
export function compareGridVersions(a: GridVersion, b: GridVersion): number {
  return a.epoch - b.epoch || a.sequence - b.sequence;
}
