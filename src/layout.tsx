import { useEffect, useState, useRef, createContext } from "react";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
export const GridHeaderTarget = createContext<HTMLDivElement | null>(null);
export function Layout() {
  const pathname = useLocation().pathname,
    isGrid = pathname.startsWith("/grid/");
  const [headerTarget, setHeaderTarget] = useState<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null),
    navigation = useRef<HTMLElement>(null);
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    const mobile = matchMedia("(max-width: 700px)");
    const close = () => setMenuOpen(false);
    mobile.addEventListener("change", close);
    return () => mobile.removeEventListener("change", close);
  }, []);
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
      <div className={`app-shell${isGrid ? " grid-layout" : ""}`}>
        <header>
          <Link to="/grids" className="wordmark" aria-label="slopgrid">
            slopgrid
            <img className="logo-grid" src="/slopgrid.svg" alt="" />
          </Link>
          {isGrid && <div className="grid-header-slot" ref={setHeaderTarget} />}
          <div className="navigation-controls">
            <button
              ref={menuButton}
              type="button"
              className="mobile-menu-toggle secondary"
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
            <nav
              id="main-navigation"
              ref={navigation}
              data-open={menuOpen}
              onClick={() => setMenuOpen(false)}
            >
              <Link to="/billing">BILLING</Link>
              <Link to="/settings">SETTINGS</Link>
            </nav>
          </div>
        </header>
        <Outlet />
      </div>
    </GridHeaderTarget.Provider>
  );
}
