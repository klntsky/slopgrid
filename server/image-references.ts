import type Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export type ReferenceContent = {
  bytes: Buffer;
  mediaType: string;
  sha256: string;
};
export type ReferenceInputs = ReadonlyMap<string, ReferenceContent>;
import type { OutputFiles } from "./files.js";
import type { Session } from "./store.js";
import { anonymousOwner } from "./session.js";
import { token } from "./ids.js";
import { ownsGrid } from "./grid-policy.js";

function migrateReferences(db: Database.Database, files: OutputFiles) {
  const references = db
    .prepare("SELECT id,sha256 FROM reference_images")
    .all() as { id: string; sha256: string | null }[];
  for (const reference of references) {
    let bytes: Buffer;
    try {
      const legacy = files.path(`reference-${reference.id}`, "image");
      if (!legacy) continue;
      bytes = readFileSync(legacy);
    } catch (error) {
      // Validation snapshots and historical uploads may not include artifacts.
      if (
        ["ENOENT", "ENOTDIR", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        continue;
      throw error;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (reference.sha256 && reference.sha256 !== sha256)
      throw new Error("Legacy reference content does not match its hash");
    files.writeReference(sha256, bytes);
    db.transaction(() => {
      db.prepare(
        "INSERT OR IGNORE INTO reference_blobs (sha256) VALUES (?)",
      ).run(sha256);
      db.prepare("UPDATE reference_images SET sha256=? WHERE id=?").run(
        sha256,
        reference.id,
      );
    }).immediate();
    // Metadata is durable before removing the old copy. A restart also finishes
    // cleanup if an earlier migration stopped between these two operations.
    files.removeArtifact(`reference-${reference.id}`);
  }
}
export function createImageReferences(
  db: Database.Database,
  files: OutputFiles,
) {
  migrateReferences(db, files);
  function get(id: string) {
    return db
      .prepare(
        "SELECT id, owner, owner_user_id AS ownerUserId, name, media_type AS mediaType, sha256 FROM reference_images WHERE id=?",
      )
      .get(id) as
      | {
          id: string;
          owner: string;
          ownerUserId?: string;
          name: string;
          mediaType: string;
          sha256: string | null;
        }
      | undefined;
  }
  function allowed(id: string, session?: Session) {
    const reference = get(id);
    if (!reference) return false;
    if (session && ownsGrid(reference, session)) return true;
    // A reference inherits access from each grid that actually uses it. Draft
    // uploads remain private; publication and forks share only selected files.
    return !!db
      .prepare(
        `SELECT 1 FROM grid_reference_images r JOIN grids g ON g.id=r.grid_id
      WHERE r.reference_id=? AND (
        g.published=1 OR
        (g.owner_user_id IS NOT NULL AND g.owner_user_id=?) OR
        (g.owner_user_id IS NULL AND g.owner=?)
      ) LIMIT 1`,
      )
      .get(
        id,
        session?.userId ?? null,
        session ? anonymousOwner(session) : null,
      );
  }
  return {
    get,
    allowed,
    add(data: Buffer, name: string, session: Session) {
      const mediaType = data
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
          ? "image/jpeg"
          : data.subarray(0, 4).toString() === "RIFF" &&
              data.subarray(8, 12).toString() === "WEBP"
            ? "image/webp"
            : undefined;
      if (!mediaType) return;
      const id = token();
      const sha256 = createHash("sha256").update(data).digest("hex");
      files.writeReference(sha256, data);
      db.transaction(() => {
        db.prepare(
          "INSERT OR IGNORE INTO reference_blobs (sha256) VALUES (?)",
        ).run(sha256);
        db.prepare(
          "INSERT INTO reference_images (id, owner, owner_user_id, name, media_type, sha256) VALUES (?,?,?,?,?,?)",
        ).run(
          id,
          anonymousOwner(session),
          session.userId ?? null,
          name,
          mediaType,
          sha256,
        );
      }).immediate();
      return { id, name };
    },
    path(id: string) {
      const reference = get(id);
      return reference?.sha256
        ? files.referencePath(reference.sha256)
        : undefined;
    },
    loader() {
      const cache = new Map<string, Promise<ReferenceContent>>();
      async function read(id: string): Promise<ReferenceContent> {
        const reference = get(id),
          path = reference?.sha256
            ? files.referencePath(reference.sha256)
            : undefined;
        if (!reference?.sha256 || !path)
          throw new Error("Reference image is unavailable");
        const bytes = await readFile(path);
        return {
          bytes,
          mediaType: reference.mediaType,
          sha256: reference.sha256,
        };
      }
      return async (ids: readonly string[]): Promise<ReferenceInputs> => {
        const images = new Map<string, ReferenceContent>();
        await Promise.all(
          ids.map(async (id) => {
            let pending = cache.get(id);
            if (!pending) {
              pending = read(id).catch((error) => {
                cache.delete(id);
                throw error;
              });
              cache.set(id, pending);
            }
            images.set(id, await pending);
          }),
        );
        return images;
      };
    },
  };
}
