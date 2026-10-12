import { useEffect, useRef, useState } from "react";
import { readReferenceFile, saveReferenceFile } from "./reference-files";
import { Paperclip, Pencil, X } from "lucide-react";
import type {
  ReferenceGroups as Groups,
  ReferenceImage,
} from "../../server/image-settings";
import { EditableTitle } from "../components/editable-title";
import { ErrorMessage } from "../components/error-message";

export function ReferenceGroups({
  values,
  groups,
  onChange,
  onBusy,
}: {
  values: string[];
  groups: Groups;
  onChange: (values: string[], groups?: Groups) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function select(files: FileList | null, group?: string) {
    if (!files?.length) return;
    const selected = Array.from(files);
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const images = await Promise.all(selected.map(saveReferenceFile));
      if (!mounted.current) return;
      let index = 1;
      while (Object.hasOwn(groups, `Group ${index}`)) index++;
      const name = group ?? `Group ${index}`;
      onChange(group ? values : [...values, name], {
        [name]: [...(group ? groups[group] : []), ...images],
      });
    } catch {
      if (mounted.current)
        setError("Could not keep these files in browser storage.");
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  function picker(group?: string) {
    return (
      <label className="button secondary reference-upload">
        {group && <Paperclip aria-hidden="true" />}
        {group ? "Add images" : "Add reference group"}
        <input
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          aria-label={group ? `Add images to ${group}` : "Add reference group"}
          disabled={busy}
          onChange={(event) => {
            void select(event.target.files, group);
            event.target.value = "";
          }}
        />
      </label>
    );
  }
  return (
    <div className="reference-groups" aria-busy={busy}>
      {values.map((name, position) => (
        <div className="reference-group" key={position}>
          <div className="reference-heading">
            <div className="reference-title-line">
              <EditableTitle
                key={name}
                value={name}
                label="Reference group title"
                editLabel={`Edit reference group title: ${name}`}
                disabled={busy}
                icon={<Pencil aria-hidden="true" />}
                onSave={(title) => {
                  if (!title) throw new Error("Enter a reference group title.");
                  if (values.includes(title))
                    throw new Error("Use a different reference group title.");
                  onChange(
                    values.map((value) => (value === name ? title : value)),
                    { [title]: groups[name] },
                  );
                }}
              />
              <span className="hint">· reference image group</span>
            </div>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              aria-label={`Remove ${name}`}
              onClick={() => onChange(values.filter((value) => value !== name))}
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <div className="reference-images">
            {(groups[name] ?? []).map((image, index) => (
              <div className="reference-image" key={`${image.id}-${index}`}>
                <ReferencePreview image={image} />
                <span>{image.name}</span>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  aria-label={`Remove ${image.name} from ${name}`}
                  onClick={() => {
                    const remaining = groups[name].filter(
                      (_, position) => position !== index,
                    );
                    onChange(
                      remaining.length
                        ? values
                        : values.filter((value) => value !== name),
                      { [name]: remaining },
                    );
                  }}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
          {picker(name)}
        </div>
      ))}
      {picker()}
      {busy && <span role="status">Reading images...</span>}
      <ErrorMessage error={error} />
    </div>
  );
}

function ReferencePreview({ image }: { image: ReferenceImage }) {
  const [url, setURL] = useState<string>();
  useEffect(() => {
    if (!image.id.startsWith("local-")) return;
    let active = true,
      objectURL: string | undefined;
    void readReferenceFile(image.id)
      .then((file) => {
        if (active && file) {
          objectURL = URL.createObjectURL(file);
          setURL(objectURL);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [image.id]);
  return (
    <img
      src={image.id.startsWith("local-") ? url : `/api/references/${image.id}`}
      alt={image.name}
    />
  );
}
