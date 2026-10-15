import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { Billing } from "./pages/billing";
import { Layout } from "./layout";
import { Create } from "./pages/create";
import { Home } from "./pages/grids";
import { Settings } from "./pages/settings";
import { GridPage } from "./pages/grid";
import { gridPageNumber } from "../shared/grid-page";
const rootRoute = createRootRoute({ component: Layout });
const createRoutePage = createRoute({
  getParentRoute: () => rootRoute,
  path: "/create",
  component: Create,
});
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
  validateSearch: (
    search: Record<string, unknown>,
  ): { yourPage?: number; publicPage?: number } => {
    const yourPage = gridPageNumber(search.yourPage);
    const publicPage = gridPageNumber(search.publicPage);
    return {
      yourPage: yourPage === 1 ? undefined : yourPage,
      publicPage: publicPage === 1 ? undefined : publicPage,
    };
  },
});
const gridsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/grids",
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: Settings,
});
const billingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/billing",
  component: Billing,
});
const gridRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/grid/$id",
  component: GridPage,
});
export const router = createRouter({
  scrollRestoration: true,
  routeTree: rootRoute.addChildren([
    createRoutePage,
    homeRoute,
    gridsRoute,
    settingsRoute,
    billingRoute,
    gridRoute,
  ]),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
