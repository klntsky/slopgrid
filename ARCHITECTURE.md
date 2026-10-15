# Architecture

Slopgrid has a React client, a web process, and a separate, long-lived inference
engine. The web process owns browser requests and access control. The engine owns
generation and provider calls. They share SQLite and an output filesystem, but
communicate about generation through a private API.

This document explains responsibilities and boundaries. Product behavior is in
[PRODUCT.md](PRODUCT.md), and setup, operations, and validation are in
[DEVELOPMENT.md](DEVELOPMENT.md).

## Process boundaries

- The React client owns creation drafts, model selection, grid views, and browser
  interactions. TanStack Router handles navigation, TanStack Query handles API
  state, and server-sent events carry live grid snapshots.
- The web process (`server/index.ts`) owns sessions, authentication, grid
  metadata, catalog data for forms, HTTP routes, and authorized output delivery.
  It delegates generation commands to the engine instead of running provider
  work in a request handler. It serves built frontend assets in production,
  retaining prior assets needed by open tabs across updates.
- The inference engine (`server/engine.ts`) owns admission, scheduling, provider
  requests, retries, cancellation, billing writes, and recovery. Its runtime
  holds active work and execution credentials that cannot be reconstructed from
  stored grids.
- The processes use a versioned HTTP API over an owner-only Unix socket. The
  web process sends start and pause commands, reads snapshots, and subscribes to
  updates. The socket has no browser-facing listener. Commands are not
  automatically replayed after a transport failure because the engine may have
  accepted them before the connection failed.

Web-only updates can replace the web process and frontend assets while the
engine continues running. Engine or shared-contract changes require a machinery
update: admission closes, accepted work and unsettled calls finish, and the
engine is replaced. The release keeps its code and dependencies fixed for its
lifetime.

## State and persistence

### Browser responsibilities

The frontend separates creation parameters, live grid state, output rendering,
and shared browser controls. Route components compose these responsibilities;
they do not own provider execution or persist generation results.

- Creation drafts belong to the browser tab. Axis changes and swaps are pure
  record transformations, while parameter controls share model selection,
  custom-size editing, and reference collections. IndexedDB holds local reference
  files, while the tab's sessionStorage draft holds their identifiers and names.
  Preview components own disposable object URLs. Each successful upload replaces its local
  reference throughout the draft before the next upload, so failures retain
  completed work. Removed or uploaded local files are released when no longer
  referenced by the draft. Validation and compatibility reuse the
  server's pure domain functions.
- Creation submissions retain a request identity for response-loss recovery.
  A successful acknowledgement clears the tab draft and creation receipt.
  One grid query cache orders snapshots from HTTP reads, commands, and live
  events. The live subscription stays connected until the engine reports a
  stable snapshot, and reconnection reads state without replaying a generation
  command.
- Output cells retain their view state independently of the server snapshot.
  Markdown source, thinking traces, image previews, and isolated website frames
  have separate rendering responsibilities. Website swaps transfer scroll
  coordinates through the trusted bootstrap before replacing the visible frame.
  The workspace owns measured column and row dimensions, their saved sizes,
  and pointer and touch gestures. Resizing changes dimensions in unscaled
  coordinates, while pinch zoom preserves the gesture's content anchor.
  Expanded cells counteract workspace zoom without remounting their content,
  keeping website frames and preview state intact. Markdown measures its
  natural width and uses browser layout scaling to fit the available space.
- Shared controls own tooltip visibility, modal focus, clipboard actions, and
  connection management. Query caching handles ordinary API reads; local
  storage holds appearance, manual keys, publication preferences, and grid sizes.
  Creation and grid routes load their implementation on demand.

Tooltips render through a portal outside clipping containers, using the active
dialog when present. The shared control positions them against their anchor and
viewport and updates placement on scrolling and resizing.

The navbar and Settings share account controls. Successful sign-out reloads
Settings to discard private query caches and live subscriptions.

### Durable state

SQLite stores identities, sessions, grid configuration, cell state, reference
metadata, creation receipts, and the inference ledger. Generated bodies,
reference bytes, and thinking traces live in the output filesystem. Storage
paths are resolved from cell and reference records rather than accepted directly
from browser input.

Store startup checks for missing listing titles before running their backfill,
so opening an up-to-date database does not require that write lock.

- Grid configuration is stored once. The engine owns generation and billing
  writes; the web process owns metadata and identity changes. Publication and
  admission use transactions so a grid cannot become public during a retry.
- Completed artifacts are written before their cell is marked complete. Live
  drafts and estimates remain in engine memory; snapshots combine that state
  with persisted metadata. Large generated bodies are not copied into SQLite
  or live snapshots.
- Each engine initialization advances a persisted epoch. Snapshots also carry
  an in-memory sequence, allowing the browser to reject older updates across
  reconnects and engine restarts. Snapshot reads do not write to SQLite.
- The engine serializes deferred persistence. When storage is temporarily
  unavailable, it stops new admission and dispatch while accepted calls retain
  their results in memory until writes succeed. A forced exit can lose results
  that were never committed.
- Engine startup recovers interrupted grids from committed state without
  launching replacement provider calls. Resume is an owner-authorized action.
  Restarting the web process does not perform generation recovery.

The inference ledger records each upstream attempt, including failed, cancelled,
and retried calls with any reported charge. It excludes prompts, outputs, and
credentials. The web process reads owner-filtered billing data; the engine alone
records calls. Live cost estimates are derived in memory and give way to reported
usage when it arrives.

## Creation and inference

Compatibility tables share model selection and name resolution, with model names
as rows and parameter values as columns. Their renderer keeps this orientation
independent of generation axes, while each table stays beside its parameter input.
The renderer selects status labels and icons with inline conditionals and names
each cell using its model, parameter value, and support status.
Image tables and provider-combination checks share support-state aggregation;
tables treat missing combinations as unknown.

The browser persists a creation draft and a request identity across reloads.
The web process validates the input and commits a creation receipt, grid, and
initial cells together. Replaying the same request resolves to the existing
grid, which lets the browser recover from a lost creation response without
starting inference twice.

- Model catalogs are loaded by the web process for forms. Provider adapters own
  catalog interpretation, credit lookup, and request preparation; they remain
  separate from HTTP routes and scheduling policy.
- Input expansion turns axes into cells. Model aliases are resolved before
  saving inputs, and shared normalization gives equivalent image settings the
  same prepared request. Compatibility information advises selection but does
  not gate inference.
- Request preparation applies format instructions, model capabilities, pricing,
  token limits, and routing. Text calls stream through the AI SDK; image calls
  use its dedicated image path. The engine budgets and schedules individual
  cell attempts.
  When pricing or context limits are unavailable, preparation omits the output
  token limit and provider price cap, leaving the output allowance to the provider.
  Streaming still estimates token counts, while unknown prices leave estimated costs
  absent; reported usage and charges remain authoritative.
- Scheduling allocates workers across owners and grids. A pause cancels active
  requests and stops queued cells; cancelled calls retain their worker slots
  until they settle. Retry and cooldown state live in the engine, while cell
  transitions and actual calls are persisted.
- OAuth credentials are encrypted at rest. Manual OpenRouter keys stay in the
  browser and, during accepted work, in engine memory. They are excluded from
  grids, snapshots, output files, and billing records; Resume after an engine
  restart needs a new submission of a manual key.

Image references are uploaded before grid creation. SQLite stores ownership and
metadata, while separate files hold the bytes. The engine loads authorized
references for dispatch, and reference bytes never enter grid snapshots.

Completed cells can be reused by Edit/Fork when a source is accessible and its
prepared request matches the new cell. A signature captures request semantics,
including ordered reference content, while a token ceiling check protects text
reuse. Reused artifacts are copied under new cell identifiers and create no new
inference ledger entry. Any unfinished cells enter the ordinary scheduler.

## Outputs and live views

The output layer owns format instructions, parsing, completed files, and
temporary previews. Website output is a bundle of validated relative paths with
an entry page. One path validator protects both stored bundles and preview
serving. Temporary previews belong to the active attempt and are cleared when
that attempt ends or the engine starts.

The engine sends snapshots containing cell state, drafts, estimates, and preview
identifiers. The web process checks the viewer's session and access before
forwarding live updates. The browser reconnects to current engine state after
a dropped stream; reconnecting does not restart inference. The client renders
Markdown from escaped source, recovers disposable SVG drafts for image display, and keeps
visible website frames stable while previews change.

Thinking traces are private, attempt-specific files. Snapshots refer to a trace
rather than embedding its text. Trace reads check ownership and the current
attempt, and traces are excluded from generated bundles and downloads.

## Identity and access

Users begin with anonymous browser sessions and may sign in with GitHub. Sign-in
claims the browser's anonymous grids and rotates its session cookie. OAuth
identity and OpenRouter inference authorization are separate flows. Grid policy
centralizes ownership and publication checks; account ownership takes precedence
after a claim.

Published grids have fixed generation inputs and outputs. Public listings expose
only listed grids, while unlisted grids remain readable by link. Mutations
require ownership. Output routes check access before reading files or download
metadata; public outputs can be served without a session.

Generated HTML runs on isolated per-cell hosts rather than the application
host. Host dispatch happens before application middleware, so those hosts cannot
reach application routes. Only validated bundle or preview paths are served.
The HTML sandbox has an opaque origin and a restrictive content security policy;
generated code cannot read application cookies or use the authorization bridge.

Private HTML needs a short handshake because navigation and sandboxed resource
requests can use different cookie partitions:

1. The application host checks the live session, cell ownership, and requested
   path, then issues a short-lived grant bound to that request.
2. Trusted bootstrap code on the output host redeems the grant for a host-only
   encrypted cookie and establishes the sandbox's resource cookie partition.
3. Every private asset request rechecks cell scope, session validity, and current
   ownership. Session rotation or deletion revokes access even if the output
   cookie remains.

Direct private HTML navigation uses the same access checks and bootstrap. The
bridge that preserves frame scroll state communicates only with its application
parent and grants no additional access.

## Code ownership

- `server/app.ts` composes web dependencies and middleware; `server/routes/`
  contains browser-facing routes. `server/generation-api.ts` and
  `server/generation-client.ts` define the private process contract.
- `server/jobs.ts` coordinates engine execution. Policy, cell lifecycle,
  provider preparation, storage, billing, and output modules own their respective
  decisions and side effects outside the scheduler.
- `src/create/` owns form state, drafts, and submission. `src/grid/` owns live
  grid state and views. Shared components and Markdown rendering live outside
  those feature directories.
