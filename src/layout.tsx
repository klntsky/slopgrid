import { useTheme } from "./theme";
import { Account } from "./components/account";
import { useEffect, useState, useRef, createContext } from "react";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { Menu, X, Sun, Moon } from "lucide-react";
export const GridHeaderTarget = createContext<HTMLDivElement | null>(null);
export function Layout() {
  // Secondary touch devices and spoofed touch counts do not change mouse navigation.
  const hasTouchscreen =
    navigator.maxTouchPoints > 0 && matchMedia("(pointer: coarse)").matches;
  const { resolvedTheme, setTheme } = useTheme();
  const pathname = useLocation().pathname,
    isGrid = pathname.startsWith("/grid/");
  const [headerTarget, setHeaderTarget] = useState<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null),
    navigation = useRef<HTMLElement>(null);
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      if (
        !navigation.current?.contains(event.target as Node) &&
        !menuButton.current?.contains(event.target as Node)
      )
        setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);
  return (
    <GridHeaderTarget.Provider value={headerTarget}>
      <div
        className={`app-shell${isGrid ? " grid-layout" : ["/billing", "/settings"].includes(pathname) ? " content-layout" : ""}`}
      >
        <header>
          <Link to="/" className="wordmark" aria-label="slopgrid">
            <img className="logo-grid" src="/slopgrid.svg" alt="" />
            <span>
              slop<span className="wordmark-grid">grid</span>
            </span>
          </Link>
          {isGrid && <div className="grid-header-slot" ref={setHeaderTarget} />}
          <div className="navigation-controls" data-touch={hasTouchscreen}>
            {hasTouchscreen && (
              <button
                ref={menuButton}
                type="button"
                className="navigation-menu-toggle secondary"
                aria-label="Navigation menu"
                aria-expanded={menuOpen}
                aria-controls="main-navigation"
                onClick={() => setMenuOpen(!menuOpen)}
              >
                {menuOpen ? (
                  <X aria-hidden="true" />
                ) : (
                  <Menu aria-hidden="true" />
                )}
              </button>
            )}
            <nav
              id="main-navigation"
              ref={navigation}
              data-open={menuOpen}
              onClick={() => setMenuOpen(false)}
            >
              <Account returnTo={pathname} />
              <Link to="/billing">BILLING</Link>
              <Link to="/settings">SETTINGS</Link>
            </nav>
            <button
              type="button"
              className="desktop-theme-toggle secondary"
              aria-label={
                resolvedTheme === "dark"
                  ? "Switch to light theme"
                  : "Switch to dark theme"
              }
              onClick={() =>
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
              }
            >
              {resolvedTheme === "dark" ? (
                <Sun aria-hidden="true" />
              ) : (
                <Moon aria-hidden="true" />
              )}
            </button>
          </div>
        </header>
        <Outlet />
        {!isGrid && (
          <footer className="site-footer">
            <a href="https://github.com/klntsky/slopgrid">source code</a>
            {" · "}
            <a href="https://twitter.com/klntsky">follow @klntsky for updates</a>
          </footer>
        )}
      </div>
    </GridHeaderTarget.Provider>
  );
}
