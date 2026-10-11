import { useContext, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import { LoaderCircle } from "lucide-react";
import { GridHeaderTarget } from "../layout";
import { useGrid } from "../grid/use-grid";
import { GridHeader } from "../grid/grid-header";
import { OutputGrid } from "../grid/output-grid";
import { Connection } from "../components/connection";
import { ErrorMessage } from "../components/error-message";
import {
  LowBalanceDialog,
  BillingDialog,
} from "../components/inference-dialogs";
import { PublishDialog } from "../components/publish-dialog";
export function GridPage() {
  const [publishing, setPublishing] = useState(false);
  const { id } = useParams({ from: "/grid/$id" });
  const headerTarget = useContext(GridHeaderTarget);
  const {
    query,
    error,
    setError,
    busy,
    dismissed,
    setDismissed,
    streamLost,
    live,
    lowBalance,
    setLowBalance,
    action,
    configure,
    publish,
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
            onPublish={() => setPublishing(true)}
            onError={setError}
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
        {g.interruption === "auth" && g.canEdit && (
          <Connection returnTo={`/grid/${id}`} />
        )}
        {streamLost && live && (
          <div role="status" className="connection-status">
            <LoaderCircle className="spinner" aria-hidden="true" />
            <span>Connection lost. Reconnecting…</span>
          </div>
        )}
        <ErrorMessage error={error} />
        <OutputGrid grid={g} />
        {publishing && (
          <PublishDialog
            initialVisibility={g.visibility}
            busy={busy}
            onPublish={publish}
            onClose={() => setPublishing(false)}
          />
        )}
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
