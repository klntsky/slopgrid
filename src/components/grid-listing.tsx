import { Link, useLocation } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { GridListPage } from "../../server/grid-listing";
import { usePublicGrids } from "../queries";
import { Author } from "./identity";
import { ErrorMessage } from "./feedback-message";
import { GridFormatIcon } from "./grid-format-icon";
import { PaginationButton } from "./pagination-button";
import { FavoriteButton } from "./favorite-button";
import { gridPageNumber } from "../../shared/grid-page";

const listingKinds = {
  owned: {
    loading: "your grids",
    empty: "You haven't created any grids yet.",
    pageParam: "yourPage",
  },
  public: {
    loading: "public grids",
    empty: "No public grids yet.",
    pageParam: "publicPage",
  },
  favorites: {
    loading: "favorites",
    empty: "You haven't starred any grids yet.",
    pageParam: "favoritesPage",
  },
} satisfies Record<
  string,
  {
    loading: string;
    empty: string;
    pageParam: "yourPage" | "publicPage" | "favoritesPage";
  }
>;
const pageParams = Object.values(listingKinds).map(
  ({ pageParam }) => pageParam,
);

export function GridListing({
  query,
  kind,
  requestedPage,
  onPageChange,
}: {
  query: UseQueryResult<GridListPage, Error>;
  kind: keyof typeof listingKinds;
  requestedPage: number;
  onPageChange: (page: number) => void;
}) {
  const labels = listingKinds[kind];
  const location = useLocation();
  const history = useRef<HTMLDivElement>(null);
  const pagination = useRef<HTMLDivElement>(null);
  const [footprint, setFootprint] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const anchor = useRef<{
    phase: "requested" | "loading";
    page: number;
    top: number;
    scrollY: number;
    width: number;
    location: typeof location;
  } | null>(null);
  const paginated =
    query.isSuccess &&
    query.data.grids.length > 0 &&
    query.data.total > query.data.pageSize;
  const clearAnchor = useCallback(function clear(event?: Event) {
    if (event?.type === "scroll" && window.scrollY === anchor.current?.scrollY)
      return;
    anchor.current = null;
    window.removeEventListener("scroll", clear);
  }, []);
  const measureHistory = useCallback(() => {
    const element = history.current;
    if (!element) return;
    const size = element.getBoundingClientRect();
    setFootprint((previous) =>
      previous?.width === size.width && previous.height >= size.height
        ? previous
        : {
            width: size.width,
            height:
              previous?.width === size.width
                ? Math.max(previous.height, size.height)
                : size.height,
          },
    );
    return size;
  }, []);
  const observeHistory = useCallback(
    (element: HTMLDivElement | null) => {
      history.current = element;
      if (!element || !paginated) return;
      measureHistory();
      const observer = new ResizeObserver(measureHistory);
      observer.observe(element);
      return () => {
        observer.disconnect();
        history.current = null;
      };
    },
    [paginated, measureHistory],
  );
  useLayoutEffect(() => {
    if (!paginated) {
      setFootprint(null);
      clearAnchor();
      return;
    }
    const size = measureHistory();
    const pending = anchor.current;
    if (!pending) return;
    if (pending.phase === "requested") {
      if (location === pending.location) return;
      const sameOtherPages = pageParams.every(
        (param) =>
          param === labels.pageParam ||
          gridPageNumber(location.search[param]) ===
            gridPageNumber(pending.location.search[param]),
      );
      if (
        location.pathname !== "/" ||
        gridPageNumber(location.search[labels.pageParam]) !== pending.page ||
        !sameOtherPages
      ) {
        clearAnchor();
        return;
      }
      pending.phase = "loading";
      pending.location = location;
    } else if (location !== pending.location) {
      clearAnchor();
      return;
    }
    if (requestedPage !== pending.page || query.isPlaceholderData) return;
    const controls = pagination.current;
    clearAnchor();
    if (
      controls &&
      size?.width === pending.width &&
      query.data?.page === pending.page &&
      window.scrollY === pending.scrollY
    )
      window.scrollBy({
        top: controls.getBoundingClientRect().top - pending.top,
        behavior: "instant",
      });
  }, [
    paginated,
    requestedPage,
    query.data,
    query.isPlaceholderData,
    location,
    labels.pageParam,
    measureHistory,
    clearAnchor,
  ]);
  useLayoutEffect(() => clearAnchor, [clearAnchor]);
  const changePage = (page: number) => {
    clearAnchor();
    const controls = pagination.current;
    const size = measureHistory();
    if (controls && size) {
      anchor.current = {
        phase: "requested",
        page,
        top: controls.getBoundingClientRect().top,
        scrollY: window.scrollY,
        width: size.width,
        location,
      };
      window.addEventListener("scroll", clearAnchor, { passive: true });
    }
    onPageChange(page);
  };
  if (query.isPending) return <p>Loading {labels.loading}...</p>;
  if (query.isError)
    return (
      <>
        <ErrorMessage>{query.error.message}</ErrorMessage>
        <button className="secondary" onClick={() => query.refetch()}>
          Reload grids
        </button>
      </>
    );
  return (
    <>
      <div
        className="grid-list-footprint"
        style={{ minHeight: paginated ? footprint?.height : undefined }}
      >
        <div className="history" ref={observeHistory}>
          {query.data.grids.length ? (
            query.data.grids.map((g) => (
              <div className="history-row" key={g.id}>
                <FavoriteButton gridId={g.id} />
                <Link
                  to={g.slug ? "/$slug" : "/grid/$id"}
                  params={{ id: g.id, slug: g.slug ?? "" }}
                  className="history-grid-link"
                >
                  <GridFormatIcon format={g.format} />
                  <span
                    className={`history-prompt${g.title ? " history-title" : ""}`}
                  >
                    {g.title || g.expanded_prompt_for_title}
                  </span>
                </Link>
                {kind !== "owned" && <Author identity={g.author} />}
                {kind === "owned" && (
                  <small>{g.published ? "published" : g.status}</small>
                )}
              </div>
            ))
          ) : (
            <p>{labels.empty}</p>
          )}
        </div>
      </div>
      {query.data.total > query.data.pageSize && (
        <div className="grid-pagination" ref={pagination}>
          <PaginationButton
            direction="previous"
            disabled={query.isFetching || query.data.page === 1}
            onClick={() => changePage(query.data.page - 1)}
          />
          <span>
            {(query.data.page - 1) * query.data.pageSize + 1}-
            {Math.min(query.data.page * query.data.pageSize, query.data.total)}{" "}
            of {query.data.total}
          </span>
          <PaginationButton
            direction="next"
            disabled={
              query.isFetching ||
              query.data.page * query.data.pageSize >= query.data.total
            }
            onClick={() => changePage(query.data.page + 1)}
          />
        </div>
      )}
    </>
  );
}

export function PublicGrids({
  page,
  onPageChange,
}: {
  page?: number;
  onPageChange: (page: number) => void;
}) {
  const publicGrids = usePublicGrids(page);
  return (
    <section className="public-grids" aria-labelledby="public-grids-title">
      <h2 id="public-grids-title" className="grid-list-title">
        Public grids{" "}
        <span className="grid-list-subtitle">
          &middot; See what others have created
        </span>
      </h2>
      <GridListing
        query={publicGrids}
        kind="public"
        requestedPage={page ?? 1}
        onPageChange={onPageChange}
      />
    </section>
  );
}
