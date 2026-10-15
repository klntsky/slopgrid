import { useRef, useState } from "react";
import { Pencil, Paperclip } from "lucide-react";
import type { ReferenceImage } from "../../server/image-settings";
import type { Draft } from "./draft";
import { ErrorMessage } from "../components/ui";
type LocalReference = ReferenceImage & { data?: string };

function readFile(file: File): Promise<LocalReference> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () =>
      resolve({
        id: `local-${crypto.randomUUID()}`,
        name: file.name,
        data: String(reader.result),
      });
    reader.readAsDataURL(file);
  });
}
export async function uploadReferences(draft: Draft): Promise<Draft> {
  const uploaded = new Map<string, ReferenceImage>();
  async function upload(images: LocalReference[] = []) {
    const result: ReferenceImage[] = [];
    for (const image of images) {
      if (!image.data) {
        result.push(image);
        continue;
      }
      if (!uploaded.has(image.id)) {
        const [header, encoded] = image.data.split(",");
        const blob = new Blob(
          [Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))],
          { type: header.slice(5).split(";")[0] },
        );
        const response = await fetch(
          `/api/references?name=${encodeURIComponent(image.name)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: blob,
          },
        );
        const data = await response.json();
        if (!response.ok) throw new Error(`Could not upload ${image.name}.`);
        uploaded.set(image.id, data);
      }
      result.push(uploaded.get(image.id)!);
    }
    return result;
  }
  const groups: Record<string, ReferenceImage[]> = {};
  for (const [name, images] of Object.entries(draft.referenceGroups ?? {}))
    groups[name] = await upload(images);
  return {
    ...draft,
    referenceGroups: groups,
    inputReferences: await upload(draft.inputReferences),
  };
}
export function References({
  label,
  values,
  onChange,
  group,
}: {
  label: string;
  values: LocalReference[];
  onChange: (values: ReferenceImage[]) => void;
  group?: string;
}) {
  const [error, setError] = useState<unknown>();
  return (
    <div>
      <label>
        <Paperclip /> Add images
        <input
          aria-label={label}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          onChange={async (e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            try {
              onChange([
                ...values,
                ...(await Promise.all(files.map(readFile))),
              ]);
            } catch (e) {
              setError(e);
            }
          }}
        />
      </label>
      {values.map((image, i) => (
        <span key={`${image.id}-${i}`}>
          <img
            width="50"
            height="50"
            src={image.data ?? `/api/references/${image.id}`}
            alt={image.name}
          />
          <button
            type="button"
            aria-label={`Remove ${image.name}${group ? ` from ${group}` : ""}`}
            onClick={() => onChange(values.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </span>
      ))}
      <ErrorMessage error={error} />
    </div>
  );
}
function GroupTitle({
  name,
  names,
  rename,
}: {
  name: string;
  names: string[];
  rename: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false),
    [value, setValue] = useState(name),
    [error, setError] = useState("");
  const button = useRef<HTMLButtonElement>(null),
    cancelled = useRef(false);
  function save() {
    if (cancelled.current) return;
    const next = value.trim();
    if (!next || (next !== name && names.includes(next))) {
      setError(
        next
          ? "Use a different reference group title."
          : "Enter a reference group title.",
      );
      return;
    }
    rename(next);
    setEditing(false);
    setError("");
  }
  return (
    <>
      {editing ? (
        <input
          autoFocus
          aria-label="Reference group title"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              cancelled.current = true;
              setEditing(false);
              setError("");
              requestAnimationFrame(() => button.current?.focus());
            }
          }}
        />
      ) : (
        <button
          type="button"
          ref={button}
          aria-label={`Edit reference group title: ${name}`}
          onClick={() => {
            cancelled.current = false;
            setValue(name);
            setEditing(true);
          }}
        >
          <Pencil />
          {name}
        </button>
      )}
      <ErrorMessage error={error} />
    </>
  );
}
export function ReferenceGroups({
  side,
  draft,
  update,
}: {
  side: "rows" | "columns";
  draft: Draft;
  update: (draft: Draft) => void;
}) {
  const axis = draft[side],
    groups = draft.referenceGroups ?? {};
  return (
    <>
      {axis.values.map((name, i) => (
        <div key={i}>
          <GroupTitle
            name={name}
            names={axis.values}
            rename={(next) => {
              if (next === name) return;
              const renamed = { ...groups, [next]: groups[name] };
              delete renamed[name];
              update({
                ...draft,
                referenceGroups: renamed,
                [side]: {
                  ...axis,
                  values: axis.values.map((v) => (v === name ? next : v)),
                },
              });
            }}
          />
          <span> · reference image group</span>
          <button
            type="button"
            aria-label={`Remove reference group: ${name}`}
            onClick={() => {
              const remaining = { ...groups };
              delete remaining[name];
              update({
                ...draft,
                referenceGroups: remaining,
                [side]: {
                  ...axis,
                  values: axis.values.filter((v) => v !== name),
                },
              });
            }}
          >
            Remove group
          </button>
          <References
            label={`Add images to ${name}`}
            group={name}
            values={groups[name] ?? []}
            onChange={(images) =>
              update({
                ...draft,
                referenceGroups: { ...groups, [name]: images },
              })
            }
          />
        </div>
      ))}
      <References
        label="Add reference group"
        values={[]}
        onChange={(images) => {
          let number = 1;
          while (axis.values.includes(`Group ${number}`)) number++;
          const name = `Group ${number}`;
          update({
            ...draft,
            [side]: { ...axis, values: [...axis.values, name] },
            referenceGroups: { ...groups, [name]: images },
          });
        }}
      />
    </>
  );
}
