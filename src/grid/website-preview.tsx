import { useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import "./website-preview.css";

export function WebsitePreview({
  url,
  title,
  streaming,
  published,
}: {
  url?: string;
  title: string;
  streaming: boolean;
  published: boolean;
}) {
  const [frames, setFrames] = useState<{ url: string; ready: boolean }[]>([]);
  const loads = useRef(new WeakMap<HTMLIFrameElement, number>());
  // Finish the in-flight frame before taking the latest snapshot, so frequent
  // updates cannot keep restarting a slow load. Completion replaces any pending
  // preview because its temporary files are removed. Keep at most two frames mounted.
  if (
    url &&
    frames.at(-1)?.url !== url &&
    (frames.every((frame) => frame.ready) || !streaming)
  )
    setFrames([
      ...frames.filter((frame) => frame.ready),
      { url, ready: false },
    ]);
  const visible = frames.some((frame) => frame.ready);
  return (
    <>
      <div className="website-preview">
        {frames.map((frame) => (
          <iframe
            key={frame.url}
            aria-label={title}
            aria-hidden={!frame.ready}
            inert={!frame.ready}
            sandbox="allow-scripts"
            src={frame.url}
            style={{ visibility: frame.ready ? "visible" : "hidden" }}
            onLoad={(event) => {
              const element = event.currentTarget;
              const count = (loads.current.get(element) ?? 0) + 1;
              loads.current.set(element, count);
              // Private navigation loads the trusted bootstrap first, then HTML.
              if (!frame.ready && count >= (published ? 1 : 2))
                setFrames([{ url: frame.url, ready: true }]);
            }}
          />
        ))}
        {streaming && !visible && (
          <div className="pending" role="status">
            <LoaderCircle className="spinner" aria-hidden="true" />
            Generating…
          </div>
        )}
      </div>
      {streaming && visible && (
        <span className="website-preview-status" role="status">
          <LoaderCircle className="spinner" aria-hidden="true" />
          Generating…
        </span>
      )}
    </>
  );
}
