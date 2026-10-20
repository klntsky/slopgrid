import { isChatFormat, type GridInput } from "../../server/domain";
import type { ReferenceImage } from "../../server/image-settings";

// Files stay in this browser across reloads and OAuth redirects until Generate.
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
export const readReferenceFile = (id: string) => localFile(id);
export const removeReferenceFile = (id: string) =>
  localFile(id, undefined, true);
export async function saveReferenceFile(file: File): Promise<ReferenceImage> {
  const id = `local-${crypto.randomUUID()}`;
  await localFile(id, file);
  return { id, name: file.name };
}
export async function uploadReferences(
  input: GridInput,
  uploaded: (localId: string, image: ReferenceImage) => void,
  signal: AbortSignal,
): Promise<GridInput> {
  const names =
    input.format === "image"
      ? [input.rows, input.columns].flatMap((axis) =>
          axis.kind === "input_references" ? axis.values : [],
        )
      : [];
  const groups = Object.fromEntries(
    names.map((name) => [name, [...input.referenceGroups![name]]]),
  );
  const inputReferences =
    input.format === "image" ? [...(input.inputReferences ?? [])] : undefined;
  const messages = input.messages?.map((message) => ({
    ...message,
    ...(message.images && { images: [...message.images] }),
  }));
  const cloneAxis = (axis: GridInput["rows"]): GridInput["rows"] =>
    axis.kind === "variable"
      ? {
          ...axis,
          values: axis.values.map((entry) =>
            entry.map((field) => ({
              ...field,
              ...(field.images && { images: [...field.images] }),
            })),
          ),
        }
      : axis;
  const rows = cloneAxis(input.rows);
  const columns = cloneAxis(input.columns);
  const references = [
    ...(isChatFormat(input.format)
      ? (messages ?? []).flatMap((message) =>
          message.images ? [message.images] : [],
        )
      : [
          ...Object.values(groups),
          ...(inputReferences ? [inputReferences] : []),
        ]),
    ...[rows, columns].flatMap((axis) =>
      axis.kind === "variable"
        ? axis.values.flatMap((entry) =>
            entry.flatMap((field) => (field.images ? [field.images] : [])),
          )
        : [],
    ),
  ];
  const replacements = new Map<string, ReferenceImage>();
  for (const images of references) {
    for (let index = 0; index < images.length; index++) {
      const image = images[index];
      if (!image.id.startsWith("local-")) continue;
      let saved = replacements.get(image.id);
      if (!saved) {
        const file = await readReferenceFile(image.id);
        if (!file)
          throw new Error(
            `Select ${image.name} again; its local file is unavailable.`,
          );
        const response = await fetch(
          `/api/references?name=${encodeURIComponent(image.name)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: file,
            signal,
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
        saved = (await response.json()) as ReferenceImage;
        replacements.set(image.id, saved);
        uploaded(image.id, saved);
      }
      images[index] = saved;
    }
  }
  return {
    ...input,
    rows,
    columns,
    messages,
    referenceGroups: input.format === "image" ? groups : undefined,
    inputReferences,
  };
}
