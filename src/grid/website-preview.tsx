import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { syncFrameScroll } from "./frame-scroll";
import "./website-preview.css";

export function WebsitePreview({
  url,
  title,
  streaming,
  published,
  offline = false,
}: {
  url?: string;
  title: string;
  streaming: boolean;
  published: boolean;
  offline?: boolean;
}) {
  const [frames, setFrames] = useState<{ url: string; ready: boolean }[]>([]);
  const loads = useRef(new WeakMap<HTMLIFrameElement, number>());
  const container = useRef<HTMLDivElement>(null);
  const [offlinePath, setOfflinePath] = useState<string>();
  useEffect(() => {
    if (!offline || !url) {
      setOfflinePath(undefined);
      return;
    }
    const prefix = new URL(url, location.origin).pathname.replace(/[^/]+$/, "");
    function navigate(event: MessageEvent) {
      const frame = container.current?.querySelector("iframe");
      if (
        event.source !== frame?.contentWindow ||
        event.data?.type !== "slopgrid:offline-navigation" ||
        typeof event.data.path !== "string"
      )
        return;
      const target = new URL(event.data.path, location.origin);
      if (
        target.origin === location.origin &&
        target.pathname.startsWith(prefix)
      )
        setOfflinePath(target.pathname + target.hash);
    }
    window.addEventListener("message", navigate);
    return () => window.removeEventListener("message", navigate);
  }, [offline, url]);
  const source = offline ? (offlinePath ?? url) : url;
  // Finish the in-flight frame before taking the latest snapshot, so frequent
  // updates cannot keep restarting a slow load. Completion replaces any pending
  // preview because its temporary files are removed. Keep at most two frames mounted.
  if (
    source &&
    frames.at(-1)?.url !== source &&
    (frames.every((frame) => frame.ready) || !streaming)
  )
    setFrames([
      ...frames.filter((frame) => frame.ready),
      { url: source, ready: false },
    ]);
  const visible = frames.some((frame) => frame.ready);
  return (
    <>
      <div className="website-preview" ref={container}>
        {frames.map((frame) => (
          <iframe
            key={frame.url}
            aria-label={title}
            aria-hidden={!frame.ready}
            inert={!frame.ready}
            // Offline navigation must reach the worker. Its response CSP applies
            // the opaque sandbox before generated code executes.
            sandbox={
              offline ? "allow-scripts allow-same-origin" : "allow-scripts"
            }
            src={frame.url}
            style={{ visibility: frame.ready ? "visible" : "hidden" }}
            onLoad={async (event) => {
              const element = event.currentTarget;
              const count = (loads.current.get(element) ?? 0) + 1;
              loads.current.set(element, count);
              // Private navigation loads the trusted bootstrap first, then HTML.
              if (!frame.ready && count >= (offline || published ? 1 : 2)) {
                const previous =
                  element.parentElement?.querySelector<HTMLIFrameElement>(
                    'iframe[aria-hidden="false"]',
                  );
                if (previous) await syncFrameScroll(previous, element);
                if (element.isConnected)
                  setFrames([{ url: frame.url, ready: true }]);
              }
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
