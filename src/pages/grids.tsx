import { useGrids } from "../queries";
import { CreateGridButton } from "../components/create-grid-button";
import { GridListing, PublicGrids } from "../components/grid-listing";

export function YourGrids() {
  const history = useGrids();
  return (
    <main className="grid-list-page">
      <section aria-labelledby="your-grids-title">
        <div className="page-title">
          <h1 id="your-grids-title" className="grid-list-title">
            Your grids
          </h1>
          <CreateGridButton />
        </div>
        <GridListing query={history} />
      </section>
      <PublicGrids />
    </main>
  );
}
