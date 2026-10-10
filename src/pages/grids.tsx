import { Link } from "@tanstack/react-router";
import { useGrids } from "../queries";
import { CreateGridButton } from "../components/create-grid-button";
import { ErrorMessage } from "../components/error-message";
export function YourGrids() {
  const history = useGrids();
  return (
    <main>
      <div className="history-heading">
        <h1>Your grids</h1>
        <CreateGridButton />
      </div>
      {history.isPending ? (
        <p>Loading your grids…</p>
      ) : history.isError ? (
        <>
          <ErrorMessage error={history.error.message} />
          <button className="secondary" onClick={() => history.refetch()}>
            Reload grids
          </button>
        </>
      ) : (
        <section className="history">
          {history.data.length ? (
            history.data.map((g) => (
              <Link to="/grid/$id" params={{ id: g.id }} key={g.id}>
                <span>{g.prompt}</span>
                <small>{g.published ? "Published" : g.status}</small>
              </Link>
            ))
          ) : (
            <p>You haven’t created any grids yet.</p>
          )}
        </section>
      )}
    </main>
  );
}
