import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { favoriteOwnerKey, queryClient } from "./queries";
import { ThemeProvider } from "./theme";
import "./style.css";
import type { GridListsBootstrap } from "../server/grid-bootstrap";
import { registerPwa, cacheGrid } from "./pwa";
import type { ViewGrid } from "./api";

declare global {
  interface Window {
    __SLOPGRID_GRIDS__?: GridListsBootstrap;
  }
}

if (window.__SLOPGRID_GRIDS__) {
  const bootstrap = window.__SLOPGRID_GRIDS__;
  queryClient.setQueryData(["session"], bootstrap.session);
  const ownerKey = favoriteOwnerKey(bootstrap.session);
  queryClient.setQueryData(
    ["favorites", ownerKey, "ids"],
    new Set(bootstrap.favoriteIds.ids),
  );
  for (const { key, data } of bootstrap.favorites)
    queryClient.setQueryData(["favorites", ownerKey, "pages", key], data);
  for (const [kind, pages] of [
    ["grids", bootstrap.owned],
    ["public-grids", bootstrap.public],
  ] as const)
    for (const { key, data } of pages)
      queryClient.setQueryData([kind, key], data);
}
delete window.__SLOPGRID_GRIDS__;

void registerPwa().then(() => {
  for (const query of queryClient.getQueryCache().getAll()) {
    if (query.queryKey[0] !== "grid") continue;
    const grid = queryClient.getQueryData<ViewGrid>(query.queryKey);
    if (grid) cacheGrid(grid);
  }
});
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
