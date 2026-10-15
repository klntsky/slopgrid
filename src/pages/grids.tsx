import { useGrids } from "../queries";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { FormatPicker } from "../components/format-picker";
import { startDraft } from "../create/draft";
import { GridListing, PublicGrids } from "../components/grid-listing";

export function Home() {
  const search = useSearch({ from: "/" });
  const history = useGrids(search.yourPage);
  const navigate = useNavigate();
  const changePage = (key: "yourPage" | "publicPage", page: number) => {
    void navigate({
      to: "/",
      search: { ...search, [key]: page > 1 ? page : undefined },
      resetScroll: false,
    });
  };
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
      {(history.isError || !!history.data?.total) && (
        <section className="owned-grids" aria-labelledby="your-grids-title">
          <h2 id="your-grids-title" className="grid-list-title">
            Your grids
          </h2>
          <GridListing
            query={history}
            onPageChange={(page) => changePage("yourPage", page)}
          />
        </section>
      )}
      <PublicGrids
        page={search.publicPage}
        onPageChange={(page) => changePage("publicPage", page)}
      />
    </main>
  );
}
