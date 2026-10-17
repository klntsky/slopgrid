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

The separate slopgrid-ops repository owns deployment orchestration. Its command
installs a committed pipeline implementation, builds and validates on staging,
selects a compatible soft update or a draining machinery update, and promotes
the same build when production is explicitly requested. Immutable releases,
retained frontend assets, private runtime configuration, and per-run records
are managed by that pipeline rather than application code.

## State and persistence

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

Failed inference-call records include a bounded chain of error names, machine
codes, HTTP statuses, system calls, and SDK retryability flags. The serializer
allows only these fields, limits identifiers to 80 characters and chains to
eight entries, and stops on cycles. It excludes free-form cause messages,
stacks, headers, URLs, and request/response payloads. These diagnostics remain
in SQLite across restarts and are omitted from billing API responses. Terminal
cell failures also log the same diagnostics beside the grid and cell identifiers,
including failures before an upstream call begins. Existing provider explanations
remain separate from these diagnostic fields, and retry policy is unchanged.

## Creation and inference

Compatibility tables share model selection, name resolution, and support-state
aggregation with provider-combination checks. Their presentation requirements
are defined in [PRODUCT.md](PRODUCT.md#34-compatibility-presentation).

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
  same prepared request. Compatibility rendering and inference admission use
  separate policy paths.
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

The grid parameters component renders through a React portal into Tippy's content container,
which is attached to the document body. Common parameters come from saved grid
input, filtered by the selected axis kinds. Reference thumbnails use the existing
authorized reference route. The component owns no generation state.

The output layer owns format instructions, parsing, completed files, and
temporary previews. Website output is a bundle of validated relative paths with
an entry page. One path validator protects both stored bundles and preview
serving. Temporary previews belong to the active attempt and are cleared when
that attempt ends or the engine starts. Browser previews and final storage share
the SVG text preparation function in `shared/svg.ts`. Its scanner tracks open
elements and quoted values without parsing or reserializing XML; code-block
extraction and namespace repair are independent of tag completion. Each preview
is derived from raw accumulated text rather than a previous repaired preview.
Output-preservation rules are defined in
[PRODUCT.md](PRODUCT.md#51-shared-controls-and-output-preservation).

Chat completion and Chat template share Markdown output parsing, storage,
previews, downloads, and copying. Their input and cells retain ordered messages,
and grid expansion substitutes variables in each message body. A derived
transcript supplies titles and prompt display. Inference sends structured
messages without an additional system instruction, and request signatures
include the history.

The template orchestrator sits between provider preparation and individual
inference calls. It resolves unfilled messages before they reach the provider,
maintains the generated history, and aggregates progress and usage. Each call
has its own billing record, while completed template cells persist aggregate
usage. Reuse provenance records per-call input, token allowance, usage, and cost
for destination-budget validation. Failed templates retain their partial draft;
the cell lifecycle clears it when a new attempt starts. Product behavior is
defined in [PRODUCT.md](PRODUCT.md).

The engine sends snapshots containing cell state, drafts, estimates, and preview
identifiers. The web process checks the viewer's session and access before
forwarding live updates. The browser reconnects to current engine state after
a dropped stream; reconnecting does not restart inference. The client renders
Markdown from escaped source, validates SVG drafts before display, and keeps
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

Grid policy centralizes mutation authorization and publication visibility.
Listing queries apply that visibility policy before selecting rows. Output
routes check access before reading files or download metadata.

The publication policy allows terminal cells and paused pending cells. Grid
responses expose that policy as `canPublish` for the interface, and publication
serializes with retry admission. Published pending cells retain their stored generation
state; the presenter maps them to the published response independently of
generation persistence, so settling canceled calls cannot restore a resumable
public cell.

Public grid slugs live in grid metadata under a unique SQLite expression index.
Publication claims a slug inside the same immediate transaction as visibility
and attribution, checking uniqueness and preserving permanent claims. Slug
resolution exposes only public grid IDs; the client then uses the existing
ID-based grid queries and actions. Root-level paths containing a hyphen and
only lowercase ASCII letters, digits, and hyphens load the grid frontend.
OAuth return-path validation also accepts valid local slug paths.

Live generated HTML runs on isolated per-cell hosts. Host dispatch happens
before application middleware, so those hosts cannot
reach application routes. Only validated bundle or preview paths are served.
Live output documents use their own origins and normal browser capabilities.
Frames delegate the browser's exposed permission-policy features, with an
explicit fallback list when policy introspection is unavailable. Browser
permission prompts, user activation, and cross-origin rules still apply.
Assets use the static server's MIME database for their content types.

The application session remains in a host-only, Secure, HttpOnly `__Host-`
cookie on HTTPS. Output origins cannot read or replace that cookie. Application
API requests from other origins, including same-site sibling hosts, are rejected
before session handlers run. Top-level OAuth callback GET navigations remain
available and require the session's pending state and verifier. The application
page's own CSP prevents other pages from framing it.

Private HTML uses a scoped authorization redirect:

1. The application host checks the live session, cell ownership, and requested
   path, then issues a short-lived grant bound to that request.
2. The output host consumes the grant, sets a host-only, encrypted, HttpOnly
   cookie referencing the live session, and redirects to the requested file.
3. Every private asset request rechecks cell scope, session validity, and current
   ownership. Session rotation or deletion revokes access even if the output
   cookie remains.

Direct private HTML navigation uses the same access checks and redirect. The
bridge that preserves frame scroll state communicates only with its application
parent and grants no additional access.

## Progressive web app and offline storage

The build emits a web manifest, PNG app icons, a service worker with the release's
asset inventory, and a generic offline shell. Installation caches the shell and
frontend assets. Hashed assets remain available for cached pages across releases;
worker activation follows the browser lifecycle without replacing a worker used
by open tabs. Registration runs alongside rendering and does not gate startup.

The worker fetches pages and read-only API data from the network first, retaining
successful responses and the list pages embedded in HTML. Network failures use
cached responses, while HTTP denials remain authoritative. Cached grid snapshots
exclude streamed drafts, temporary previews, and live thinking. Visiting a grid
or receiving completed cells triggers caching of ready outputs and downloads.
Reconnection refreshes active queries before live streams resume. Mutations and
OAuth exchanges remain network-only.

Session responses carry a one-way hash of the session identifier as a cache
partition key, which grants no server access. Sign-out and observed session
changes remove cached data; an epoch check rejects writes from obsolete requests.
Offline copies remain readable in their last known session until the browser can
observe revocation online. Cache writes are serialized, quota errors evict older
data entries, and storage failures do not prevent online requests from succeeding.
Draft storage and the application shell are separate from replaceable cached data.

Completed website bundles also have a self-contained offline representation.
HTML, CSS imports, static resource references, and module imports are rewritten
to embedded data URLs. The original bundle remains available as a cached ZIP.
Offline HTML documents are served at application paths under `/offline/outputs/`
with a response-level opaque sandbox and a policy that prohibits network access,
forms, and nested frames. These documents cannot read application cookies,
storage, or the parent DOM. The iframe permits worker interception of the initial
navigation; the response policy imposes isolation before generated code runs.
Its navigation bridge accepts only the current frame and paths within its own
output. Generated scripts that construct resource URLs at runtime are not
rewritten; reconnecting restores the original website preview.

## Code ownership

Controls explicitly attach contextual hints through the shared tooltip helper.
Tippy handles positioning outside clipping containers, while the helper owns
content updates and Escape dismissal. Its document key listener exists only
while the tooltip is visible and is removed on hiding or destruction.

The navbar owns its navigation popup above the grid workspace. The workspace
contains grid stacking layers and expanded previews, keeping their ordering
independent of navigation.

The grid page occupies a fixed viewport shell, keeping its header independent
of document scrolling on the previous route. The grid viewport owns scrolling
within that shell, while the router restores ordinary-page scroll positions
through browser history.

Markdown previews, thinking traces, and text clipboard actions share an output
query keyed by the canonical source URL. Completed text is cached once, while
preview components retain streaming drafts until the saved output arrives.
Image clipboard conversion remains separate from text loading.

The grid viewport owns measured and saved dimensions, zoom, and pointer
gestures in one lifecycle. Resizing and pinch anchoring use its shared
coordinate space, and gesture handlers share capture and cleanup. The output
grid supplies labels and cells without maintaining a second geometry model.

The grid workspace owns the expanded selection and focus restoration. Output
cells stay mounted while their presentation expands within the workspace;
website browsing contexts and preview state are retained without a second
output tree or scroll transfer between copies. The workspace owns background
inertness independently of the navbar.

The browser query client owns grid snapshot ordering for HTTP reads, command
responses, and live events. Its grid cache rule compares engine epochs and
sequences before accepting replacements; individual update paths write through
that cache without maintaining separate ordering state.

- `server/app.ts` composes web dependencies and middleware; `server/routes/`
  contains browser-facing routes. `server/generation-api.ts` and
  `server/generation-client.ts` define the private process contract.
- `server/jobs.ts` coordinates engine execution. Policy, cell lifecycle,
  provider preparation, storage, billing, and output modules own their respective
  decisions and side effects outside the scheduler.
- `src/create/` owns form state, drafts, and submission. `src/grid/` owns live
  grid state and views. Shared components and Markdown rendering live outside
  those feature directories.
- The home and creation routes share the format picker and persisted draft.
  Route components compose listing queries and form state; navigation behavior
  is defined in [PRODUCT.md](PRODUCT.md#31-form-and-output-selection).
- Grid listing queries filter ownership or public visibility in SQLite before
  counting and selecting a page. Only that page's grids are loaded for summary
  presentation, with counts and rows read in one transaction. The list APIs
  return grids, total, page, and pageSize, and validate the requested page.
  Independent query keys and home search parameters retain each list's page.
- Home HTML embeds the requested page and its next two available pages for
  each list from one database snapshot. Creation HTML embeds the first three
  available pages of both lists, and the creation page uses the same list hooks
  to prefetch them during client navigation without displaying the lists.
  Production and development use the same
  session-filtered bootstrap. Request-specific HTML uses HTTP no-store and varies
  by cookie, while the service worker retains session-scoped offline copies. It
  escapes script content and permits its inline script with a CSP hash.
  Before React renders, these pages seed the existing query cache. List queries
  share a 30-second freshness period and prefetch only the next two available
  pages; existing mutation invalidation refreshes affected cached lists.
