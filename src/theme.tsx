import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type ResolvedTheme = "light" | "dark";
type Theme = "system" | ResolvedTheme;
function preference(value: string | null): Theme {
  return value === "light" || value === "dark" ? value : "system";
}
function savedTheme(): Theme {
  try {
    return preference(localStorage.getItem("slopgrid-theme"));
  } catch {
    return "system";
  }
}
const ThemeContext = createContext<{
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}>({
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => {},
});
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState(savedTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  useEffect(() => {
    const system = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved =
        theme === "system" ? (system.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      setResolvedTheme(resolved);
      const background = getComputedStyle(document.documentElement)
        .getPropertyValue("--background")
        .trim();
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", background);
    };
    apply();
    system.addEventListener("change", apply);
    return () => system.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === "slopgrid-theme" || event.key === null)
        setTheme(preference(event.newValue));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  function chooseTheme(next: Theme) {
    setTheme(next);
    try {
      if (next === "system") localStorage.removeItem("slopgrid-theme");
      else localStorage.setItem("slopgrid-theme", next);
    } catch {}
  }
  return (
    <ThemeContext.Provider
      value={{ theme, resolvedTheme, setTheme: chooseTheme }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
export function useTheme() {
  return useContext(ThemeContext);
}
