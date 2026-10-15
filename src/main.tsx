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
import { Menu } from "lucide-react";
import { queries, api, useSession } from "./api";
import { ThemeToggle } from "./theme";
import { IconButton } from "./components/ui";
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
  const { data: session } = useSession();
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
              <Menu />
            </IconButton>
            {menu && (
              <nav className="menu" onClick={() => setMenu(false)}>
                <Link to="/billing">BILLING</Link>
                <Link to="/settings">SETTINGS</Link>
              </nav>
            )}
          </div>
        )}
        <div className="account">
          {session?.user ? (
            <>
              <a href={session.user.profileURL}>{session.user.username}</a>
              <button
                onClick={async () => {
                  await api("/api/auth/logout", {});
                  await queries.invalidateQueries();
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <a
              aria-label="Sign in with GitHub"
              href={`/api/auth/github/start?returnTo=${encodeURIComponent(pathname)}`}
            >
              <img src="/github-invertocat-white.svg" alt="GitHub" />
            </a>
          )}
        </div>
      </header>
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
