import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { syncFrameScroll } from "./frame-scroll";
import "./website-preview.css";

// Delegate every feature the browser exposes; the fallback covers browsers
// without policy introspection. Browser permissions and user activation still apply.
const outputPermissions = (
  (
    document as Document & { featurePolicy?: { features(): string[] } }
  ).featurePolicy?.features() ?? [
    "accelerometer",
    "autoplay",
    "camera",
    "clipboard-read",
    "clipboard-write",
    "display-capture",
    "encrypted-media",
    "fullscreen",
    "gamepad",
    "geolocation",
    "gyroscope",
    "hid",
    "idle-detection",
    "local-fonts",
    "magnetometer",
    "microphone",
    "midi",
    "payment",
    "picture-in-picture",
    "publickey-credentials-create",
    "publickey-credentials-get",
    "screen-wake-lock",
    "serial",
    "speaker-selection",
    "storage-access",
    "usb",
    "web-share",
    "window-management",
    "xr-spatial-tracking",
  ]
)
  .map((feature) => `${feature} *`)
  .join("; ");

export function WebsitePreview({
  url,
  title,
  streaming,
  offline = false,
}: {
  url?: string;
  title: string;
  streaming: boolean;
  offline?: boolean;
}) {
  const [frames, setFrames] = useState<
    { url: string; ready: boolean; offline: boolean }[]
  >([]);
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
  const retainedFrame = offline
    ? frames.find((frame) => frame.ready && !frame.offline)
    : undefined;
  const source = offline ? (offlinePath ?? url) : url;
  // Retain live documents during disconnection, including their local state.
  // Discard pending loads so a failed request cannot replace the visible frame.
  // Otherwise finish the in-flight frame before taking the latest snapshot.
  // Completion replaces temporary previews. Keep at most two frames mounted.
  if (retainedFrame && frames.length > 1) setFrames([retainedFrame]);
  if (
    !retainedFrame &&
    source &&
    frames.at(-1)?.url !== source &&
    (frames.every((frame) => frame.ready) || !streaming)
  )
    setFrames([
      ...frames.filter((frame) => frame.ready),
      { url: source, ready: false, offline },
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
              frame.offline ? "allow-scripts allow-same-origin" : undefined
            }
            allow={frame.offline ? undefined : outputPermissions}
            allowFullScreen={!frame.offline}
            src={frame.url}
            style={{ visibility: frame.ready ? "visible" : "hidden" }}
            onLoad={async (event) => {
              const element = event.currentTarget;
              if (!frame.ready) {
                const previous =
                  element.parentElement?.querySelector<HTMLIFrameElement>(
                    'iframe[aria-hidden="false"]',
                  );
                if (previous) await syncFrameScroll(previous, element);
                if (element.isConnected) setFrames([{ ...frame, ready: true }]);
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
