type ScrollPositions = [string, number, number][];

function exchange(frame: Window, positions?: ScrollPositions) {
  return new Promise<unknown>((resolve) => {
    const { port1, port2 } = new MessageChannel();
    function finish(value?: unknown) {
      clearTimeout(timeout);
      port1.close();
      port2.close();
      resolve(value);
    }
    // Generated scripts may remove or navigate away from the bridge.
    const timeout = setTimeout(finish, 500);
    port1.onmessage = (event) => finish(event.data);
    frame.postMessage({ type: "slopgrid:scroll", positions }, "*", [port2]);
  });
}

export async function syncFrameScroll(
  previous: HTMLIFrameElement,
  next: HTMLIFrameElement,
) {
  if (!previous.contentWindow || !next.contentWindow) return;
  const positions = await exchange(previous.contentWindow);
  if (
    next.isConnected &&
    Array.isArray(positions) &&
    positions.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 3 &&
        typeof entry[0] === "string" &&
        Number.isFinite(entry[1]) &&
        Number.isFinite(entry[2]),
    )
  )
    await exchange(next.contentWindow, positions);
}
