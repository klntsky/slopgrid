import { Link } from "@tanstack/react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import type { GridListPage } from "../../server/grid-listing";
import { usePublicGrids } from "../queries";
import { Author } from "./identity";
import { ErrorMessage } from "./error-message";
import { GridFormatIcon } from "./grid-format-icon";

export function GridListing({
  query,
  publicListing = false,
  onPageChange,
}: {
  query: UseQueryResult<GridListPage, Error>;
  publicListing?: boolean;
  onPageChange: (page: number) => void;
}) {
  if (query.isPending)
    return <p>Loading {publicListing ? "public grids" : "your grids"}...</p>;
  if (query.isError)
    return (
      <>
        <ErrorMessage error={query.error.message} />
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
              <Link
                to="/grid/$id"
                params={{ id: g.id }}
                className="history-grid-link"
              >
                <GridFormatIcon format={g.format} />
                <span
                  className={`history-prompt${g.title ? " history-title" : ""}`}
                >
                  {g.title || g.expanded_prompt_for_title}
                </span>
              </Link>
              {publicListing && <Author identity={g.author} />}
              {!publicListing && (
                <small>{g.published ? "published" : g.status}</small>
              )}
            </div>
          ))
        ) : (
          <p>
            {publicListing
              ? "No public grids yet."
              : "You haven't created any grids yet."}
          </p>
        )}
      </div>
      {query.data.total > query.data.pageSize && (
        <div className="grid-pagination">
          <button
            className="secondary"
            disabled={query.isFetching || query.data.page === 1}
            onClick={() => onPageChange(query.data.page - 1)}
          >
            Previous
          </button>
          <span>
            {(query.data.page - 1) * query.data.pageSize + 1}-
            {Math.min(query.data.page * query.data.pageSize, query.data.total)}{" "}
            of {query.data.total}
          </span>
          <button
            className="secondary"
            disabled={
              query.isFetching ||
              query.data.page * query.data.pageSize >= query.data.total
            }
            onClick={() => onPageChange(query.data.page + 1)}
          >
            Next
          </button>
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
        Public grids
      </h2>
      <p>See what others have created</p>
      <GridListing
        query={publicGrids}
        publicListing
        onPageChange={onPageChange}
      />
    </section>
  );
}
