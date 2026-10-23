import { useFavoriteGrids, useGrids, useSession } from "../queries";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { FormatPicker } from "../components/format-picker";
import { startDraft } from "../create/draft";
import { GridListing, PublicGrids } from "../components/grid-listing";
import { ErrorMessage } from "../components/feedback-message";

export function Home() {
  const search = useSearch({ from: "/" });
  const history = useGrids(search.yourPage);
  const session = useSession();
  const favorites = useFavoriteGrids(search.favoritesPage);
  const navigate = useNavigate();
  const changePage = (
    key: "yourPage" | "publicPage" | "favoritesPage",
    page: number,
  ) => {
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
      {session.isSuccess && favorites.isPending && (
        <p role="status">Loading favorites...</p>
      )}
      {session.isSuccess && favorites.isError && !favorites.data?.total && (
        <div className="favorites-feedback">
          <ErrorMessage>{favorites.error.message}</ErrorMessage>
          <button
            className="secondary"
            onClick={() => void favorites.refetch()}
          >
            Reload favorites
          </button>
        </div>
      )}
      {session.isSuccess && !!favorites.data?.total && (
        <section
          className="favorite-grids"
          aria-labelledby="favorite-grids-title"
        >
          <h2 id="favorite-grids-title" className="grid-list-title">
            Favorites
          </h2>
          <GridListing
            kind="favorites"
            query={favorites}
            onPageChange={(page) => changePage("favoritesPage", page)}
          />
        </section>
      )}
      {(history.isError || !!history.data?.total) && (
        <section className="owned-grids" aria-labelledby="your-grids-title">
          <h2 id="your-grids-title" className="grid-list-title">
            Your grids
          </h2>
          <GridListing
            query={history}
            kind="owned"
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
