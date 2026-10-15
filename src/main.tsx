import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
  Link,
  useRouterState,
  lazyRouteComponent,
} from "@tanstack/react-router";
import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import { Menu, X } from "lucide-react";
import { queries } from "./api";
import { Account } from "./components/account";
import { ThemeToggle } from "./theme";
import { IconButton, ErrorMessage } from "./components/ui";
import { GridsPage, BillingPage, SettingsPage } from "./pages";
import "./style.css";

function Layout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const [menu, setMenu] = useState(false);
  const media = matchMedia("(pointer: coarse)");
  const touch = useSyncExternalStore(
    (callback) => {
      media.addEventListener("change", callback);
      return () => media.removeEventListener("change", callback);
    },
    () => media.matches,
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const observer = new ResizeObserver(() =>
      document.documentElement.style.setProperty(
        "--navbar-height",
        `${headerRef.current?.offsetHeight ?? 64}px`,
      ),
    );
    observer.observe(headerRef.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(false);
        menuRef.current?.querySelector("button")?.focus();
      }
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", key);
    };
  }, [menu]);
  return (
    <div className={pathname.startsWith("/grid/") ? "app grid-page" : "app"}>
      <header className="navbar" ref={headerRef}>
        <Link to="/grids" className="brand" aria-label="slopgrid">
          <img src="/slopgrid.svg" alt="" />
          <span>
            slop<span className="accent">grid</span>
          </span>
        </Link>
        <div id="grid-navigation" />
        {!touch ? (
          <nav className="desktop-navigation">
            <Account />
            <Link to="/billing">BILLING</Link>
            <Link to="/settings">SETTINGS</Link>
            <ThemeToggle />
          </nav>
        ) : (
          <div className="touch-navigation" ref={menuRef}>
            <IconButton
              label="Navigation menu"
              className="icon-button navigation-menu-toggle"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              {menu ? <X /> : <Menu />}
            </IconButton>
            {menu && (
              <nav className="menu" onClick={() => setMenu(false)}>
                <Account />
                <Link to="/billing">BILLING</Link>
                <Link to="/settings">SETTINGS</Link>
              </nav>
            )}
          </div>
        )}
      </header>
      {new URLSearchParams(location.search).get("signin") === "failed" && (
        <ErrorMessage error="GitHub sign-in failed. Sign in again." />
      )}
      <Outlet />
    </div>
  );
}
const rootRoute = createRootRoute({ component: Layout });
const createRouteEntry = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./create/page"), "CreatePage"),
});
const gridRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/grid/$id",
  component: lazyRouteComponent(() => import("./grid/page"), "GridPage"),
});
const gridsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/grids",
  component: GridsPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});
const billingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/billing",
  component: BillingPage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([
    createRouteEntry,
    gridRoute,
    gridsRoute,
    settingsRoute,
    billingRoute,
  ]),
  scrollRestoration: true,
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queries}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
