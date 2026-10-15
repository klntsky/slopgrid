import { useSyncExternalStore } from "react";

let offline = !navigator.onLine;
const listeners = new Set<() => void>();
export function setOffline(value: boolean) {
  if (offline === value) return;
  offline = value;
  for (const listener of listeners) listener();
}
window.addEventListener("online", () => setOffline(false));
window.addEventListener("offline", () => setOffline(true));
export function useOffline() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => offline,
  );
}
export async function registerPwa() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  try {
    if (!navigator.onLine && navigator.serviceWorker.controller) return;
    await navigator.serviceWorker.register("/sw.js", {
      updateViaCache: "none",
    });
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener(
            "controllerchange",
            finish,
          );
          resolve();
        };
        const timer = setTimeout(finish, 5000);
        navigator.serviceWorker.addEventListener("controllerchange", finish);
        if (navigator.serviceWorker.controller) finish();
      });
    if (navigator.serviceWorker.controller) {
      // The first navigation precedes worker control. Retain it and its embedded
      // list pages before a later offline visit needs to reconstruct the route.
      void fetch(location.href).catch(() => {});
      void fetch("/api/session").catch(() => {});
    }
  } catch {
    /* Browsing still works when storage or service workers are unavailable. */
  }
}
export function cacheGrid(id: string) {
  navigator.serviceWorker?.controller?.postMessage({ type: "cache-grid", id });
}
