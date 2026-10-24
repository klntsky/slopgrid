import type { Request, Response } from "express";
import type { Store } from "./store.js";
import {
  presentSession,
  type SessionInfo,
  type SessionReader,
} from "./session.js";
import { gridListPage, type GridListPage } from "./grid-listing.js";
import { gridPageNumber } from "../shared/grid-page.js";
import { createFavorites, type FavoriteIds } from "./favorites.js";

export type GridListsBootstrap = {
  session: SessionInfo;
  favoriteIds: FavoriteIds;
  favorites: { key: number; data: GridListPage }[];
  owned: { key: number; data: GridListPage }[];
  public: { key: number; data: GridListPage }[];
};

export function createGridBootstrap(store: Store, session: SessionReader) {
  const favorites = createFavorites(store);
  return (req: Request, res: Response): GridListsBootstrap => {
    const owner = session(req, res);
    const listingPage = ["/", "/index.html", "/grids", "/create"].includes(
      req.path,
    );
    const firstPage = req.path === "/grids" || req.path === "/create";
    const window = (
      requested: number,
      read: (page: number) => GridListPage,
    ) => {
      if (!listingPage) return [];
      const current = read(requested);
      const pages = [{ key: requested, data: current }];
      const last = Math.min(
        current.page + 2,
        Math.ceil(current.total / current.pageSize),
      );
      for (let page = current.page + 1; page <= last; page++)
        pages.push({ key: page, data: read(page) });
      return pages;
    };
    return store.db.transaction(() => ({
      session: presentSession({ store, viewer: owner }),
      favoriteIds: favorites.ids({ viewer: owner }),
      favorites: window(
        firstPage ? 1 : gridPageNumber(req.query.favoritesPage),
        (page) => favorites.page({ viewer: owner, page }),
      ),
      owned: window(
        firstPage ? 1 : gridPageNumber(req.query.yourPage),
        (page) => gridListPage(store, page, owner),
      ),
      public: window(
        firstPage ? 1 : gridPageNumber(req.query.publicPage),
        (page) => gridListPage(store, page),
      ),
    }))();
  };
}
