type FavoriteChange = {
  kind: "favorites-changed";
  nonce: string;
};

const storageKey = "slopgrid-favorites-changed";
const channelName = "slopgrid-favorites-changed";
let channel: BroadcastChannel | undefined;
let lastNonce: string | undefined;

function parseFavoriteChange(value: unknown): FavoriteChange | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "favorites-changed" ||
    !("nonce" in value) ||
    typeof value.nonce !== "string" ||
    value.nonce.length === 0
  ) {
    return;
  }
  return { kind: "favorites-changed", nonce: value.nonce };
}

export function publishFavoriteChange(): void {
  const change: FavoriteChange = {
    kind: "favorites-changed",
    nonce: `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,
  };
  lastNonce = change.nonce;
  try {
    channel?.postMessage(change);
  } catch {}
  try {
    localStorage.setItem(storageKey, JSON.stringify(change));
  } catch {}
}

export function subscribeFavoriteChanges(listener: () => void): () => void {
  const receive = (value: unknown) => {
    const change = parseFavoriteChange(value);
    if (!change || change.nonce === lastNonce) return;
    lastNonce = change.nonce;
    listener();
  };
  const receiveMessage = (event: MessageEvent<unknown>) => receive(event.data);
  const receiveStorage = (event: StorageEvent) => {
    if (event.key !== storageKey || event.newValue === null) return;
    let value: unknown;
    try {
      value = JSON.parse(event.newValue);
    } catch {
      return;
    }
    receive(value);
  };

  let ownedChannel: BroadcastChannel | undefined;
  try {
    ownedChannel = new BroadcastChannel(channelName);
  } catch {}
  channel = ownedChannel;
  ownedChannel?.addEventListener("message", receiveMessage);
  window.addEventListener("storage", receiveStorage);

  return () => {
    window.removeEventListener("storage", receiveStorage);
    ownedChannel?.removeEventListener("message", receiveMessage);
    if (channel === ownedChannel) channel = undefined;
    ownedChannel?.close();
  };
}
