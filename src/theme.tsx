import { useSyncExternalStore } from "react";
import { Sun, Moon } from "lucide-react";
import { IconButton } from "./components/ui";

type Theme = "system" | "light" | "dark";
const media = matchMedia("(prefers-color-scheme: dark)");
function preference(): Theme {
  try {
    return (localStorage.getItem("slopgrid-theme") as Theme) || "system";
  } catch {
    return "system";
  }
}
function apply(value: Theme) {
  document.documentElement.dataset.theme =
    value === "system" ? (media.matches ? "dark" : "light") : value;
}
media.addEventListener("change", () => {
  if (preference() === "system") {
    apply("system");
    window.dispatchEvent(new Event("theme"));
  }
});
window.addEventListener("storage", (event) => {
  if (event.key === "slopgrid-theme" || event.key === null) {
    apply(preference());
    window.dispatchEvent(new Event("theme"));
  }
});
export function setTheme(value: Theme) {
  try {
    localStorage.setItem("slopgrid-theme", value);
  } catch {}
  const change = () => {
    apply(value);
    window.dispatchEvent(new Event("theme"));
  };
  if (document.startViewTransition) document.startViewTransition(change);
  else change();
}
export function useTheme() {
  return useSyncExternalStore((callback) => {
    window.addEventListener("theme", callback);
    return () => window.removeEventListener("theme", callback);
  }, preference);
}
export function useResolvedTheme() {
  return useSyncExternalStore(
    (callback) => {
      window.addEventListener("theme", callback);
      return () => window.removeEventListener("theme", callback);
    },
    () =>
      document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
}
export function ThemeToggle() {
  const dark = useResolvedTheme() === "dark";
  return (
    <IconButton
      label={`Switch to ${dark ? "light" : "dark"} theme`}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? <Sun /> : <Moon />}
    </IconButton>
  );
}
