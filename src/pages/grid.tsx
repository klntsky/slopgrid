import { useContext } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle } from "lucide-react";
import { GridHeaderTarget } from "../layout";
import { useGrid } from "../grid/use-grid";
import { GridHeader } from "../grid/grid-header";
import { OutputGrid } from "../grid/output-grid";
import { ErrorMessage } from "../components/feedback-message";
import { useOffline } from "../pwa";
import { isGridFinished } from "../../server/domain";
import {
  LowBalanceDialog,
  BillingDialog,
} from "../components/inference-dialogs";
export function GridPage({ id }: { id: string }) {
  const offline = useOffline();
  const headerTarget = useContext(GridHeaderTarget);
  const {
    query,
    error,
    busy,
    dismissed,
    setDismissed,
    reconnecting,
    lowBalance,
    setLowBalance,
    action,
    configure,
  } = useGrid(id);
  if (query.isError && !reconnecting)
    return (
      <main>
        <ErrorMessage>{query.error.message}</ErrorMessage>
        {offline && (
          <button className="secondary" onClick={() => void query.refetch()}>
            Retry
          </button>
        )}
      </main>
    );
  if (!query.data)
    return (
      <main>{reconnecting ? <ConnectionStatus /> : <p>Loading grid…</p>}</main>
    );
  const g = query.data;
  const paused =
    g.status === "paused" && g.canEdit && !g.published && !isGridFinished(g);
  return (
    <>
      {headerTarget &&
        createPortal(
          <GridHeader
            grid={g}
            busy={busy}
            onAction={action}
            onConfigure={configure}
          />,
          headerTarget,
        )}
      <main className="grid-page">
        {g.interruption === "restart" && (
          <p role="status">
            Generation stopped when the server restarted. Resume generation to
            continue.
          </p>
        )}
        {reconnecting && <ConnectionStatus />}
        <ErrorMessage>{error}</ErrorMessage>
        <OutputGrid key={g.id} grid={g} />
        {paused && lowBalance !== null && (
          <LowBalanceDialog
            balanceUsd={lowBalance}
            busy={busy}
            error={error}
            onProceed={(override) => action("retry", override)}
            onClose={() => setLowBalance(null)}
          />
        )}
        {g.interruption === "billing" &&
          paused &&
          !dismissed &&
          lowBalance === null && (
            <BillingDialog
              busy={busy}
              error={error}
              onRetry={() => action("retry")}
              onClose={() => setDismissed(true)}
            />
          )}
      </main>
    </>
  );
}

function ConnectionStatus() {
  return (
    <div role="status" className="connection-status">
      <LoaderCircle className="spinner" aria-hidden="true" />
      <span>Connection lost. Reconnecting…</span>
    </div>
  );
}
