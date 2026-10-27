import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { OutputFiles } from "./files.js";
import type { ChatMessage, FilledChatMessage } from "./domain.js";
import {
  saveBlob,
  storedDimensions,
  type ReferenceContent,
} from "./image-references.js";
import { materializeChatMessages } from "./chat-messages.js";
import { writeChatOutput } from "../shared/chat-output.js";
import { imageDimensions } from "./image-dimensions.js";

const oldReference = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
const oldInlineImage = z
  .strictObject({
    kind: z.literal("generated").optional(),
    name: z.string().min(1),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    dataUrl: z.string().max(28_000_000),
  })
  .refine((image) => {
    const prefix = `data:${image.mediaType};base64,`;
    const data = image.dataUrl.slice(prefix.length);
    return (
      image.dataUrl.startsWith(prefix) &&
      data.length > 0 &&
      data.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(data)
    );
  });
const oldMessages = z.array(
  z
    .strictObject({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
      images: z.array(z.union([oldReference, oldInlineImage])).optional(),
    })
    .refine((message) => !message.images?.length || message.role !== "system"),
);
const oldTemplate = z.array(
  z.strictObject({
    role: z.enum(["system", "user", "assistant", "unfilled"]),
    content: z.string(),
    images: z.array(oldReference).optional(),
  }),
);

function unavailable(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR", "EACCES"].includes(
    (error as NodeJS.ErrnoException).code ?? "",
  );
}

export function migrateReferenceFiles(
  db: Database.Database,
  files: OutputFiles,
): void {
  const references = db
    .prepare("SELECT id,sha256 FROM reference_images")
    .all() as {
    id: string;
    sha256: string | null;
  }[];
  for (const reference of references) {
    let bytes: Buffer;
    try {
      const path = files.path(`reference-${reference.id}`, "image");
      if (!path) continue;
      bytes = readFileSync(path);
    } catch (error) {
      if (unavailable(error)) continue;
      throw error;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (reference.sha256 && reference.sha256 !== sha256)
      throw new Error("Legacy reference content does not match its hash");
    const installed = files.referencePath(sha256);
    if (installed && !readFileSync(installed).equals(bytes))
      throw new Error("Reference blob content does not match its hash");
    files.writeReference(sha256, bytes);
    saveBlob(
      db,
      sha256,
      storedDimensions(db, sha256) ?? imageDimensions(bytes),
    );
    db.prepare("UPDATE reference_images SET sha256=? WHERE id=?").run(
      sha256,
      reference.id,
    );
  }
  const blobs = db
    .prepare("SELECT sha256 FROM reference_blobs WHERE width IS NULL")
    .all() as {
    sha256: string;
  }[];
  for (const { sha256 } of blobs) {
    try {
      const path = files.referencePath(sha256);
      if (!path) continue;
      const dimensions = imageDimensions(readFileSync(path));
      if (dimensions) saveBlob(db, sha256, dimensions);
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
  }
  // Legacy sources are retained. Removing them before the outer commit breaks retry safety.
}

export function migrateChatOutputs(
  db: Database.Database,
  files: OutputFiles,
): void {
  const findReference = db.prepare(
    "SELECT sha256,media_type AS mediaType FROM reference_images WHERE id=?",
  );
  function supplied(message: ChatMessage): FilledChatMessage {
    const references = new Map<string, ReferenceContent>();
    for (const image of message.images ?? []) {
      if (references.has(image.id)) continue;
      const reference = findReference.get(image.id) as
        | {
            sha256: string | null;
            mediaType: string;
          }
        | undefined;
      const path = reference?.sha256
        ? files.referencePath(reference.sha256)
        : undefined;
      if (!reference?.sha256 || !path)
        throw new Error(
          `Required historical chat image ${image.id} is unavailable`,
        );
      const bytes = readFileSync(path);
      if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256)
        throw new Error(
          `Required historical chat image ${image.id} has invalid content`,
        );
      references.set(image.id, {
        bytes,
        mediaType: reference.mediaType,
        sha256: reference.sha256,
      });
    }
    return materializeChatMessages([message], references)[0];
  }
  function convert(json: string, template: ChatMessage[]): string {
    const messages = oldMessages.parse(JSON.parse(json));
    const converted: FilledChatMessage[] = messages.map((message, index) => {
      const configured = template[index];
      const storedImages = message.images ?? [];
      const images = storedImages.flatMap((image) => {
        if ("id" in image)
          return supplied({
            role: message.role,
            content: message.content,
            images: [image],
          }).images!;
        const { kind: _kind, ...inline } = image;
        return [inline];
      });
      if (
        configured?.role !== "unfilled" &&
        configured?.images?.length &&
        storedImages.every((image) => "kind" in image)
      ) {
        if (configured.role !== message.role)
          throw new Error(
            "Historical chat prefix does not match its accepted input",
          );
        images.unshift(...supplied(configured).images!);
      }
      return {
        role: message.role,
        content: message.content,
        ...(images.length ? { images } : {}),
      };
    });
    return writeChatOutput(converted);
  }
  const rows = db
    .prepare(
      "SELECT id,artifact_id,data FROM workflow_tasks WHERE kind='generation' ORDER BY rowid",
    )
    .all() as { id: string; artifact_id: string | null; data: string }[];
  const save = db.prepare(
    "UPDATE workflow_tasks SET artifact_id=?,data=? WHERE id=?",
  );
  for (const row of rows) {
    const data = JSON.parse(row.data) as {
      input: { format: string; messages?: unknown };
      output?: { provenance: { files: string[] } };
      progress?: { draft?: string };
    };
    if (data.input.format !== "chat-template") continue;
    try {
      const template = oldTemplate.parse(data.input.messages ?? []);
      let artifactId = row.artifact_id;
      if (artifactId) {
        const path = files.path(artifactId, "messages.json");
        if (!path) throw new Error("Historical chat artifact is unavailable");
        const replacement: Record<string, string | Uint8Array> =
          Object.create(null);
        const inventory = data.output?.provenance.files;
        if (!inventory?.includes("messages.json"))
          throw new Error(
            "Historical chat artifact has no transcript inventory",
          );
        for (const filename of inventory) {
          const source = files.path(artifactId, filename);
          if (!source)
            throw new Error(
              `Historical artifact file ${filename} is unavailable`,
            );
          replacement[filename] =
            filename === "messages.json"
              ? convert(readFileSync(source, "utf8"), template)
              : readFileSync(source);
        }
        artifactId = files.writeImmutable(replacement);
      }
      if (data.progress?.draft !== undefined)
        data.progress.draft = convert(data.progress.draft, template);
      save.run(artifactId, JSON.stringify(data), row.id);
    } catch (cause) {
      throw new Error(
        `Cannot migrate chat task ${row.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }
}
