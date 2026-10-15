import type { ReferenceImage } from "../../server/image-settings";
import type { Draft } from "./draft";

// Read data URLs from existing drafts; new selections store only IDs and names.
export type LocalReference = ReferenceImage & { data?: string };

function localFile(
  id: string,
  file?: File,
  remove = false,
): Promise<File | undefined> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open("slopgrid-reference-files", 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore("files");
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const transaction = db.transaction(
        "files",
        file || remove ? "readwrite" : "readonly",
      );
      const store = transaction.objectStore("files");
      const request = file
        ? store.put(file, id)
        : remove
          ? store.delete(id)
          : store.get(id);
      transaction.oncomplete = () => {
        db.close();
        resolve(file ?? (remove ? undefined : request.result));
      };
      transaction.onabort = transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
    };
  });
}
export const removeReferenceFile = (id: string) =>
  localFile(id, undefined, true);
export async function saveReferenceFile(file: File): Promise<ReferenceImage> {
  const id = `local-${crypto.randomUUID()}`;
  await localFile(id, file);
  return { id, name: file.name };
}
export async function readReferenceFile(image: LocalReference): Promise<Blob> {
  if (image.data) {
    const [header, encoded] = image.data.split(",");
    return new Blob(
      [Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))],
      { type: header.slice(5).split(";")[0] },
    );
  }
  const file = await localFile(image.id);
  if (!file)
    throw new Error(
      `Select ${image.name} again; its local file is unavailable.`,
    );
  return file;
}
export function referenceFiles(draft: Draft): ReferenceImage[] {
  return [
    ...(draft.inputReferences ?? []),
    ...Object.values(draft.referenceGroups ?? {}).flat(),
  ];
}
export function replaceReference(
  draft: Draft,
  id: string,
  saved: ReferenceImage,
): Draft {
  const replace = (images: ReferenceImage[] = []) =>
    images.map((image) => (image.id === id ? saved : image));
  return {
    ...draft,
    inputReferences: replace(draft.inputReferences),
    referenceGroups: Object.fromEntries(
      Object.entries(draft.referenceGroups ?? {}).map(([name, images]) => [
        name,
        replace(images),
      ]),
    ),
  };
}
export async function uploadReferences(
  draft: Draft,
  onUploaded: (id: string, image: ReferenceImage) => void,
): Promise<Draft> {
  let prepared = draft;
  const uploaded = new Set<string>();
  for (const image of referenceFiles(draft)) {
    if (!image.id.startsWith("local-") || uploaded.has(image.id)) continue;
    const response = await fetch(
      `/api/references?name=${encodeURIComponent(image.name)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: await readReferenceFile(image),
      },
    );
    if (!response.ok)
      throw new Error(
        response.status === 413
          ? `${image.name} is too large.`
          : response.status === 400
            ? `Could not upload ${image.name}. Use PNG, JPEG, or WebP.`
            : `Could not upload ${image.name}.`,
      );
    const saved = (await response.json()) as ReferenceImage;
    prepared = replaceReference(prepared, image.id, saved);
    onUploaded(image.id, saved);
    uploaded.add(image.id);
  }
  return prepared;
}
