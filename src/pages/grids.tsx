import { useGrids } from "../queries";
import { useNavigate } from "@tanstack/react-router";
import { FormatPicker } from "../components/format-picker";
import { startDraft } from "../create/draft";
import { GridListing, PublicGrids } from "../components/grid-listing";

export function Home() {
  const history = useGrids();
  const navigate = useNavigate();
  return (
    <main className="home-page">
      <div className="page-heading">
        <h1>Create your own AI model benchmark</h1>
      </div>
      <FormatPicker
        onSelect={(format) => {
          startDraft(format);
          void navigate({ to: "/create" });
        }}
      />
      {(history.isError || !!history.data?.length) && (
        <section className="owned-grids" aria-labelledby="your-grids-title">
          <h2 id="your-grids-title" className="grid-list-title">
            Your grids
          </h2>
          <GridListing query={history} />
        </section>
      )}
      <PublicGrids />
    </main>
  );
}
