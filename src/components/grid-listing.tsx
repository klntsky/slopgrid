import { Link } from "@tanstack/react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import type { GridListPage } from "../../server/grid-listing";
import { usePublicGrids } from "../queries";
import { Author } from "./identity";
import { ErrorMessage } from "./feedback-message";
import { GridFormatIcon } from "./grid-format-icon";
import { PaginationButton } from "./pagination-button";
import { FavoriteButton } from "./favorite-button";

export function GridListing({
  query,
  kind,
  onPageChange,
}: {
  query: UseQueryResult<GridListPage, Error>;
  kind: "owned" | "public" | "favorites";
  onPageChange: (page: number) => void;
}) {
  const labels = {
    owned: {
      loading: "your grids",
      empty: "You haven't created any grids yet.",
    },
    public: { loading: "public grids", empty: "No public grids yet." },
    favorites: {
      loading: "favorites",
      empty: "You haven't starred any grids yet.",
    },
  }[kind];
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
      <div className="history">
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
      {query.data.total > query.data.pageSize && (
        <div className="grid-pagination">
          <PaginationButton
            direction="previous"
            disabled={query.isFetching || query.data.page === 1}
            onClick={() => onPageChange(query.data.page - 1)}
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
            onClick={() => onPageChange(query.data.page + 1)}
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
        onPageChange={onPageChange}
      />
    </section>
  );
}
