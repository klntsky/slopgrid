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

SQLite stores identities, sessions, grid configuration, workflow tasks, cell-to-task
links, reference metadata, creation receipts, and the inference ledger. Cells are
resolved presentation records, not execution state. Generated bodies, reference
bytes, and thinking traces live behind the artifact store; browser-supplied paths
never select stored content.

Schema upgrades and historical backfills run transactionally before storage opens.
Queryable ownership, publication, task dependencies, artifact references, and
billing metadata live in relational columns; selected reference images have
explicit grid links. JSON holds configuration and structured task/provider
payloads rather than query keys.

- Grid configuration is stored once. The engine owns generation and billing
  writes; the web process owns metadata and identity changes. Publication and
  admission use transactions so a grid cannot become public during a retry.
- Immutable artifacts are installed before the generation task commits its output
  reference. Live drafts and estimates remain in engine memory; snapshots project
  task state onto cells. Failed template transcripts and durable trace references
  belong to the task. Output metadata carries provenance, per-call usage, and
  allowances without embedding output bytes.
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

The inference ledger records each provider call, including failed, cancelled,
and retried calls with any reported charge. Calls carry a task identity, durable
attempt identifier, effective model selection, and a cell for display attribution.
Generation usage is reconstructed independently of judge calls and earlier
generation attempts.
The ledger excludes prompts, outputs, and credentials. The web process reads
owner-filtered billing data; the engine alone records calls. Live generation
estimates remain in memory and give way to reported usage.

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
initial tasks and cell links together. Replaying the same request resolves to the
existing grid, which lets the browser recover from a lost creation response without
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
  use its dedicated image path. The engine budgets generation and schedules
  workflow task attempts.
  When pricing or context limits are unavailable, preparation omits the output
  token limit and provider price cap, leaving the output allowance to the provider.
  Streaming still estimates token counts, while unknown prices leave estimated costs
  absent; reported usage and charges remain authoritative.
- Scheduling allocates workers across owners and grids. A pause cancels active
  requests and stops queued tasks; cancelled calls retain their worker slots
  until they settle. Retry and cooldown state live in the engine, while task
  transitions and actual calls are persisted.
- OAuth credentials are encrypted at rest. Manual OpenRouter keys stay in the
  browser and, during accepted work, in engine memory. They are excluded from
  grids, snapshots, output files, and billing records; Resume after an engine
  restart needs a new submission of a manual key.

Image references are uploaded before grid creation. SQLite stores ownership and
metadata, while separate files hold the bytes. The engine loads authorized
references for dispatch, and reference bytes never enter grid snapshots.

Committed generation can be reused by Edit/Fork when a source is accessible and
its prepared request matches the destination. A signature captures request
semantics, including ordered reference content, while a token ceiling check
protects text reuse. Reuse creates a new generation task referencing the same
immutable artifact and saved usage. Judgment tasks are always independent.

## Workflow and content execution

Creation assigns durable generation and judgment tasks before scheduling.
Equivalent judged cells share a generation task; ordinary cells keep independent
generations. Cells link to those tasks, and judgments depend on committed
generation output. The browser-safe grouping key remains separate from the
provider request signature.

- The scheduler owns admission, worker reservations, attempt identity, retries,
  cancellation, settlement, and serialized persistence through one task lifecycle.
  It delegates execution without performing format, provider, or filesystem work.
- The content executor owns generation and judge adapters, streaming progress,
  previews, reference loading, artifact installation, and content cleanup. Its
  commit boundary keeps late results from replacing a newer attempt.
- Generation commits an opaque artifact reference and provenance before judging
  begins. Shared cells and reused generations resolve that reference directly;
  output authorization remains attached to the requested cell.
- Artifact and thinking-trace deletion checks remaining task references. The
  operations repository owns offline transfer and administrative deletion using
  the same shared-ownership boundary.
- The judge adapter owns strict structured results independently of generation
  parsing and reads committed content rather than browser previews.
- SVG rasterization uses cancellable Node workers with local WASM and bundled
  font bytes. Workers have no browser or host-resource resolver. Rendered content
  is shared within a generation task; the content executor manages its lifetime.
- The presenter exposes output readiness separately from overall cell completion.
  Cell controls and offline caching consume that boundary. Billing owns actual
  task charges and grid spending; generation usage stays separate for Cost and
  token counts.

## Outputs and live views

The grid parameters control renders through a React portal into a Tippy content
container attached to the document body and owns its popup interaction and focus
return, not engine state. Common parameters come from saved grid input, filtered
by selected axis kinds; reference thumbnails use the authorized reference route.

The grid owns per-cell content selection, expansion state, and criterion-aware
scroll coordination across judgment views. Cells keep output previews mounted
while output, thinking, and judgment are alternate views. Judgment presentation
combines saved criteria with persisted results and does not own inference or
billing state.

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

Chat completion retains the `chat-template` storage identifier and stores the completed
message array as a JSON output artifact and streams that same representation.
The shared conversation renderer formats each message body separately, keeping
message boundaries independent of Markdown content. Grid previews and standalone
outputs use the same renderer and styles; raw views, copying, and downloads use
the stored JSON. The output reader also supports existing Markdown transcripts.
Chat inputs retain ordered messages, and grid expansion substitutes
variables in each message body. A derived transcript supplies titles and prompt
display. Inference sends structured messages without an additional system
instruction, and request signatures include the history.

Generation attempts are the shared content-execution boundary for every output
format. The content executor coordinates provider calls and progress within the
scheduler's task attempt. The provider adapter prepares and executes individual
requests. Ordinary generation uses one request, while the template
strategy resolves a shared call sequence and maintains the generated history
within the same attempt. Execution and artifact reuse derive that sequence from
the template, including its final completion when needed. The request context
applies cancellation, billing, and the
persistence barrier to every call. A request waits for its billing record and
earlier queued writes before reaching the provider, and cancellation interrupts
that wait.

Template requests use the generation task ID as the OpenRouter routing session
across calls and retries. The attempt tracks the preceding request's prefix length; the
provider adapter marks that boundary and the current history's end with ephemeral
cache controls. These request-only controls leave saved messages and artifact
signatures unchanged. Provider cache eligibility and retention determine hits.

Usage comes from the attempt's durable billing records for every format,
including failed calls when usage is reported. Shared artifacts retain their
saved usage without acquiring another attempt's billing records. Reuse
provenance records each template call's output token allowance, usage, and cost.
The reuse check uses reported input-token counts and current pricing to calculate
each call's destination allowance.
Failed templates retain their partial draft, while cancellation, restart, and
a new attempt discard unfinished previews. Product behavior is defined in
[PRODUCT.md](PRODUCT.md).

The engine sends snapshots containing cell state, drafts, estimates, and preview
identifiers. The web process checks the viewer's session and access before
forwarding live updates. The browser reconnects to current engine state after
a dropped stream; reconnecting does not restart inference. The client renders
Markdown from escaped source, validates SVG drafts before display, and keeps
visible website frames stable while previews change.

Thinking traces are private, attempt-specific files. Snapshots refer to a trace
rather than embedding its text. Reads authorize the requested cell and resolve its
generation's trace reference. Traces are excluded from bundles and downloads.

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
exclude streamed drafts, temporary previews, and live thinking. Output readiness,
rather than judgment completion, triggers caching of saved outputs and downloads.
Persisted verdicts remain snapshot data. Reconnection refreshes active queries
before live streams resume. Mutations and OAuth exchanges remain network-only.
Cache activation migrates retained snapshot records before serving them to the
new client, preserving session partitions, saved output bytes, and verdicts.

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

Markdown and conversation previews, thinking traces, and text clipboard actions
share an output query keyed by the canonical source URL. Completed text is cached once, while
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
- `server/jobs.ts` owns the task lifecycle and scheduling policy.
  `server/workflow-executor.ts` owns content execution; provider preparation,
  storage, billing, and output modules keep their respective side effects.
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
