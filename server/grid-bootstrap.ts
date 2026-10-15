import type { Request, Response } from "express";
import type { Store } from "./store.js";
import type { SessionReader } from "./session.js";
import { gridListPage, type GridListPage } from "./grid-listing.js";
import { gridPageNumber } from "../shared/grid-page.js";

export type GridListsBootstrap = {
  owned: { key: number; data: GridListPage }[];
  public: { key: number; data: GridListPage }[];
};

export function createGridBootstrap(store: Store, session: SessionReader) {
  return (req: Request, res: Response): GridListsBootstrap | undefined => {
    if (!["/", "/index.html", "/grids"].includes(req.path)) return;
    const owner = session(req, res);
    const window = (requested: number, owned: boolean) => {
      const read = (page: number) =>
        gridListPage(store, page, owned ? owner : undefined);
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
      owned: window(
        req.path === "/grids" ? 1 : gridPageNumber(req.query.yourPage),
        true,
      ),
      public: window(
        req.path === "/grids" ? 1 : gridPageNumber(req.query.publicPage),
        false,
      ),
    }))();
  };
}
