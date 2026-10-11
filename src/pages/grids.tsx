import { Link } from "@tanstack/react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import type { GridSummary } from "../../server/domain";
import { useGrids, usePublicGrids } from "../queries";
import { CreateGridButton } from "../components/create-grid-button";
import { ErrorMessage } from "../components/error-message";
import { GridFormatIcon } from "../components/grid-format-icon";

function GridListing({
  query,
  publicListing = false,
}: {
  query: UseQueryResult<GridSummary[], Error>;
  publicListing?: boolean;
}) {
  if (query.isPending)
    return <p>Loading {publicListing ? "public grids" : "your grids"}…</p>;
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
          <Link to="/grid/$id" params={{ id: g.id }} key={g.id}>
            <GridFormatIcon format={g.format} />
            <span className="history-prompt">{g.prompt}</span>
            <small>{g.published ? "Published" : g.status}</small>
          </Link>
        ))
      ) : (
        <p>
          {publicListing
            ? "No public grids yet."
            : "You haven’t created any grids yet."}
        </p>
      )}
    </div>
  );
}
export function YourGrids() {
  const history = useGrids();
  const publicGrids = usePublicGrids();
  return (
    <main>
      <section aria-labelledby="your-grids-title">
        <div className="history-heading">
          <h1 id="your-grids-title">Your grids</h1>
          <CreateGridButton />
        </div>
        <GridListing query={history} />
      </section>
      <section className="public-grids" aria-labelledby="public-grids-title">
        <h2 id="public-grids-title">Public grids</h2>
        <p>See what others have created</p>
        <GridListing query={publicGrids} publicListing />
      </section>
    </main>
  );
}
