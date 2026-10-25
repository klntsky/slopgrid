import type Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { imageDimensions, type Dimensions } from "./image-dimensions.js";
import type { ChatMessage, GridInput, WorkflowTask } from "./domain.js";
import { generatorInputEntries } from "./generator-input.js";
import type { ReferenceImage } from "./image-settings.js";

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

export class ReferenceImageUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("Reference image is unavailable", options);
    this.name = "ReferenceImageUnavailableError";
  }
}

export function storedDimensions(db: Database.Database, sha256: string) {
  const blob = db
    .prepare("SELECT width,height FROM reference_blobs WHERE sha256=?")
    .get(sha256) as { width: number | null; height: number | null } | undefined;
  return blob?.width && blob.height
    ? { width: blob.width, height: blob.height }
    : undefined;
}

export function saveBlob(
  db: Database.Database,
  sha256: string,
  dimensions?: Dimensions,
) {
  db.prepare(
    "INSERT OR IGNORE INTO reference_blobs (sha256,width,height) VALUES (?,?,?)",
  ).run(sha256, dimensions?.width ?? null, dimensions?.height ?? null);
  if (dimensions)
    db.prepare(
      "UPDATE reference_blobs SET width=?,height=? WHERE sha256=? AND width IS NULL",
    ).run(dimensions.width, dimensions.height, sha256);
}
export function createImageReferences(
  db: Database.Database,
  files: OutputFiles,
) {
  function get(id: string) {
    const reference = db
      .prepare(
        `SELECT r.id,r.owner,r.owner_user_id AS ownerUserId,r.name,
          r.media_type AS mediaType,r.sha256,b.width,b.height
        FROM reference_images r LEFT JOIN reference_blobs b ON b.sha256=r.sha256
        WHERE r.id=?`,
      )
      .get(id) as
      | {
          id: string;
          owner: string;
          ownerUserId?: string;
          name: string;
          mediaType: string;
          sha256: string | null;
          width: number | null;
          height: number | null;
        }
      | undefined;
    if (!reference) return;
    const { width, height, ...metadata } = reference;
    return { ...metadata, ...(width && height ? { width, height } : {}) };
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
  function hydrate(image: ReferenceImage): ReferenceImage {
    const reference = get(image.id);
    return {
      id: image.id,
      name: image.name,
      ...(reference?.width && reference.height
        ? { width: reference.width, height: reference.height }
        : {}),
    };
  }
  function messages(
    messages: ChatMessage[] | undefined,
  ): ChatMessage[] | undefined {
    return messages?.map((message) =>
      message.images
        ? {
            ...message,
            images: message.images.map(hydrate),
          }
        : message,
    );
  }
  function input<T extends GridInput>(input: T): T {
    // Cloning the already-admitted value preserves its opaque admission type.
    // Hydration changes metadata only, never ownership or reference identity.
    const hydrated = structuredClone(input);
    for (const { messages } of generatorInputEntries(hydrated))
      for (const message of messages)
        if (message.images) message.images = message.images.map(hydrate);
    for (const record of [...hydrated.rows, ...hydrated.columns]) {
      for (const field of record.variable ?? [])
        if (field?.images) field.images = field.images.map(hydrate);
    }
    return hydrated;
  }
  return {
    get,
    allowed,
    hydrate,
    messages,
    input,
    task(task: WorkflowTask) {
      if (task.kind === "judge") {
        if (task.input.images)
          task.input.images = task.input.images.map(hydrate);
      } else task.input.messages = messages(task.input.messages);
    },
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
      const sha256 = createHash("sha256").update(data).digest("hex");
      return db
        .transaction(() => {
          const dimensions =
            storedDimensions(db, sha256) ?? imageDimensions(data);
          if (!dimensions) return;
          const id = token();
          files.writeReference(sha256, data);
          saveBlob(db, sha256, dimensions);
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
          return { id, name, ...dimensions };
        })
        .immediate();
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
          throw new ReferenceImageUnavailableError();
        let bytes: Buffer;
        try {
          bytes = await readFile(path);
        } catch (error) {
          if (
            ["ENOENT", "ENOTDIR", "EACCES"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            throw new ReferenceImageUnavailableError({ cause: error });
          throw error;
        }
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
