import { useSyncExternalStore } from "react";
const storageKey = "slopgrid-openrouter-key";
const listeners = new Set<() => void>();
export function getOpenRouterKey(): string {
  return localStorage.getItem(storageKey) ?? "";
}
export function setOpenRouterKey(key: string) {
  if (key) localStorage.setItem(storageKey, key);
  else localStorage.removeItem(storageKey);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const changed = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) listener();
  };
  window.addEventListener("storage", changed);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", changed);
  };
}
export function useOpenRouterKey() {
  return useSyncExternalStore(subscribe, getOpenRouterKey);
}
