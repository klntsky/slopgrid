import { useContext } from "react";
import { useParams } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import { LoaderCircle } from "lucide-react";
import { GridHeaderTarget } from "../layout";
import { useGrid } from "../grid/use-grid";
import { GridHeader } from "../grid/grid-header";
import { OutputGrid } from "../grid/output-grid";
import { GridParameters } from "../grid/grid-parameters";
import { ErrorMessage } from "../components/error-message";
import { useOffline } from "../pwa";
import {
  LowBalanceDialog,
  BillingDialog,
} from "../components/inference-dialogs";
export function GridPage() {
  const offline = useOffline();
  const { id } = useParams({ from: "/grid/$id" });
  const headerTarget = useContext(GridHeaderTarget);
  const {
    query,
    error,
    busy,
    dismissed,
    setDismissed,
    streamLost,
    live,
    lowBalance,
    setLowBalance,
    action,
    configure,
  } = useGrid(id);
  if (query.isPending)
    return (
      <main>
        <p>Loading grid…</p>
      </main>
    );
  if (query.isError)
    return (
      <main>
        <ErrorMessage error={query.error.message} />
        {offline && (
          <button className="secondary" onClick={() => void query.refetch()}>
            Retry
          </button>
        )}
      </main>
    );
  const g = query.data;
  const paused = g.status === "paused" && g.canEdit && !g.published;
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
        {streamLost && live && (
          <div role="status" className="connection-status">
            <LoaderCircle className="spinner" aria-hidden="true" />
            <span>Connection lost. Reconnecting…</span>
          </div>
        )}
        <ErrorMessage error={error} />
        {g.input.format === "image" && <GridParameters key={g.id} grid={g} />}
        <OutputGrid grid={g} />
        {lowBalance !== null && (
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
