import { useEffect, useRef, useState } from "react";

function coordinates(
  frame: HTMLIFrameElement,
  positions?: unknown,
): Promise<unknown> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(undefined);
    }, 500);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(e.data);
    };
    frame.contentWindow?.postMessage(
      { type: "slopgrid:scroll", positions },
      "*",
      [channel.port2],
    );
  });
}
export function Website({ url }: { url: string }) {
  const [frames, setFrames] = useState([url, ""]);
  const [visible, setVisible] = useState(0);
  const refs = useRef<(HTMLIFrameElement | null)[]>([]),
    latest = useRef(url);
  latest.current = url;
  useEffect(() => {
    if (frames[visible] !== url)
      setFrames((previous) =>
        previous.map((value, index) => (index === visible ? value : url)),
      );
  }, [url, visible, frames[visible]]);
  // The application URL performs the authorization handshake. Frames remain opaque;
  // the bootstrap's MessageChannel exposes scroll coordinates, never output access.
  return (
    <div className="website-preview">
      {frames.map(
        (source, index) =>
          source && (
            <iframe
              key={index}
              ref={(node) => {
                refs.current[index] = node;
              }}
              title={
                index === visible ? "Website output" : "Loading website preview"
              }
              src={source}
              className={index === visible ? undefined : "pending-frame"}
              sandbox="allow-scripts allow-same-origin"
              onLoad={async () => {
                if (index === visible) return;
                const old = refs.current[visible],
                  next = refs.current[index];
                const positions = old ? await coordinates(old) : undefined;
                if (next && positions) await coordinates(next, positions);
                if (latest.current === source) {
                  setVisible(index);
                  setFrames((previous) =>
                    previous.map((value, i) => (i === index ? value : "")),
                  );
                }
              }}
            />
          ),
      )}
    </div>
  );
}
