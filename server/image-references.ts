import type Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export type ReferenceContent = {
  bytes: Buffer;
  mediaType: string;
  sha256: string;
};
import type { OutputFiles } from "./files.js";
import type { Session } from "./store.js";
import { anonymousOwner } from "./session.js";
import { token } from "./ids.js";
import { ownsGrid } from "./grid-policy.js";

export function createImageReferences(
  db: Database.Database,
  files: OutputFiles,
) {
  function get(id: string) {
    return db
      .prepare(
        "SELECT id, owner, owner_user_id AS ownerUserId, name, media_type AS mediaType FROM reference_images WHERE id=?",
      )
      .get(id) as
      | {
          id: string;
          owner: string;
          ownerUserId?: string;
          name: string;
          mediaType: string;
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
        `SELECT 1 FROM grids g, json_tree(g.data, '$.input.referenceGroups') r
      WHERE r.key='id' AND r.value=? AND (
        json_extract(g.data,'$.published')=1 OR
        (json_extract(g.data,'$.ownerUserId') IS NOT NULL AND json_extract(g.data,'$.ownerUserId')=?) OR
        (json_extract(g.data,'$.ownerUserId') IS NULL AND json_extract(g.data,'$.owner')=?)
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
      files.write(`reference-${id}`, { image: data });
      db.prepare(
        "INSERT INTO reference_images (id, owner, owner_user_id, name, media_type) VALUES (?,?,?,?,?)",
      ).run(
        id,
        anonymousOwner(session),
        session.userId ?? null,
        name,
        mediaType,
      );
      return { id, name };
    },
    path(id: string) {
      return files.path(`reference-${id}`, "image");
    },
    loader() {
      const cache = new Map<string, Promise<ReferenceContent>>();
      async function read(id: string): Promise<ReferenceContent> {
        const reference = get(id),
          path = files.path(`reference-${id}`, "image");
        if (!reference || !path)
          throw new Error("Reference image is unavailable");
        const bytes = await readFile(path);
        return {
          bytes,
          mediaType: reference.mediaType,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }
      return (ids: readonly string[]) =>
        Promise.all(
          ids.map((id) => {
            let pending = cache.get(id);
            if (!pending) {
              pending = read(id).catch((error) => {
                cache.delete(id);
                throw error;
              });
              cache.set(id, pending);
            }
            return pending;
          }),
        );
    },
  };
}
