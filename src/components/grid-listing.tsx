import { Link } from "@tanstack/react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import type { GridSummary } from "../../server/domain";
import { usePublicGrids } from "../queries";
import { Author } from "./identity";
import { ErrorMessage } from "./error-message";
import { GridFormatIcon } from "./grid-format-icon";

export function GridListing({
  query,
  publicListing = false,
}: {
  query: UseQueryResult<GridSummary[], Error>;
  publicListing?: boolean;
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
    <div className="history">
      {query.data.length ? (
        query.data.map((g) => (
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
                {g.title || g.prompt}
              </span>
            </Link>
            <Author identity={g.author} />
            {!publicListing && (
              <small>{g.published ? "Published" : g.status}</small>
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
  );
}

export function PublicGrids() {
  const publicGrids = usePublicGrids();
  return (
    <section className="public-grids" aria-labelledby="public-grids-title">
      <h2 id="public-grids-title" className="grid-list-title">
        Public grids
      </h2>
      <p>See what others have created</p>
      <GridListing query={publicGrids} publicListing />
    </section>
  );
}
