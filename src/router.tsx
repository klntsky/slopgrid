import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Billing } from "./pages/billing";
import { Layout } from "./layout";
import { Create } from "./pages/create";
import { YourGrids } from "./pages/grids";
import { Settings } from "./pages/settings";
import { GridPage } from "./pages/grid";
const rootRoute = createRootRoute({ component: Layout });
const createRoutePage = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Create,
});
const gridsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/grids",
  component: YourGrids,
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
