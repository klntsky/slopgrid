# Architecture

Slopgrid separates its web process from a long-lived inference engine. The web
process owns HTTP requests and access control. The engine owns generation and
provider calls. They share SQLite and an output filesystem, but communicate about
generation through a private API.

This document explains responsibilities and boundaries. Product behavior is in
[PRODUCT.md](PRODUCT.md), and setup, operations, and validation are in
[DEVELOPMENT.md](DEVELOPMENT.md).

## Process boundaries

- The web process (`server/index.ts`) owns sessions, authentication, grid
  metadata, catalog data for forms, HTTP routes, and authorized output delivery.
  It delegates generation commands to the engine instead of running provider
  work in a request handler. It serves built frontend assets in production,
  retaining prior assets needed by open tabs across updates.
  Requests accepted during startup wait for engine and frontend initialization
  and are served once the HTTP routes are ready.
  Parent supervisors receive readiness and the bound listener port after
  initialization. Isolated fixtures let the web process allocate its own listener
  instead of probing and releasing a port before the process starts.
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

Development and candidate validation own isolated runtimes rather than sharing
staging state. Each development worktree has its own persistent storage and
encryption key, private engine socket, loopback web listener, and application
hostname. Development and production run the same web and engine entrypoints
and share frontend routing, model/grid bootstrapping, and HTML response handling.
Vite supplies development modules and HMR; production supplies built assets and
their cache policy. The development launcher owns both process lifetimes and
keeps HMR on the web listener. Browser fixtures own independent temporary runtimes.
Credentials remain in ignored local configuration; deployed runtime locations do
not select development or candidate state.

The repository's `ops/` directory owns deployment orchestration for committed
revisions, including release builds, update-mode selection, draining, promotion,
and deployment status. Immutable releases, retained frontend assets, private
deployed runtime configuration, and deployment records belong to that pipeline,
not to the development launcher or application request handlers. Candidate
validation uses run-owned build and runtime state without deploying a shared
site. Production remains a single runtime. The pipeline authorizes its resolved
revision against the authoritative remote `master` tip before upload and before
production changes. Per-worktree isolation belongs to development and candidate
validation, not parallel production sites.

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

The web process validates the input and commits a creation receipt, grid, and
initial tasks and cell links together. Replaying the same request resolves to the
existing grid without starting inference twice.

The editor uses a structural draft schema that permits unfinished inputs and
keeps budget entry as text. Canonical validation produces opaque accepted input;
durable creation and workflow construction require that result. Stored metadata
and draft hydration do not confer validation. Advisory previews may inspect an
unvalidated candidate without granting generation admission.

Current definitions give each parameter one ownership source, with aligned
case values on rows or columns. Case-dimension identity is independent of
optional numbered fields. Budget remains an inference setting outside that
ownership model. The form and canonical schemas share field types but have
separate admission responsibilities.

Canonical validation retains field paths through parameter selection and cell
expansion. The form routes those paths to common controls and case editors
through shared feedback, rather than rerunning parameter-specific validity
checks. Nested editor paths identify individual messages, criteria, and fields.

Creation components own presentation, menu and editor focus, and pointer and
keyboard interaction. Parameter ownership transitions remain in the form action
layer; changing a control's placement does not create another conversion or
validation path. Shared prompt, conversation, and criteria editors serve both
common fields and case cells, while the case matrix owns orientation and its
scrolling workspace.

Historical configuration has a read-only boundary. Stored accepted task inputs
drive cell projection, billing, and output access independently of editor
definitions. Configuration compatibility is separate from ownership permission;
old grids retain ordinary owner controls without entering current admission.

- Model catalogs are loaded by the web process for forms. Provider adapters own
  catalog interpretation, credit lookup, and request preparation; they remain
  separate from HTTP routes and scheduling policy.
- Input expansion selects each cell's owned generator input before resolving
  numbered references once. Generator inputs share a message-history model;
  prompt-based interfaces edit a single user message, while Chat interfaces
  edit complete histories. Model aliases are resolved before saving inputs,
  and shared normalization gives equivalent image settings the same request.
- One compatibility engine checks resolved cells. Its results supply form
  warnings and validity, with source locations identifying the affected controls.
  The API applies the same checks before admission; execution consumes concrete
  tasks without interpreting form ownership or repeating compatibility checks.
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

Ordinary dimensions own one independent scalar parameter; case dimensions own
aligned records containing complete generator inputs, parameter selections,
and optional numbered fields. The editor keeps prompt and Chat representations
distinct while both feed the same validated cell-expansion boundary. Variable
token identities survive field deletion.

Setup validation pairs templates with their actual case values and resolves
generator messages and judge criteria independently. Execution receives concrete
inputs rather than form ownership or numbered templates. Format-specific request
instructions remain separate from conversation filling. Reuse keys describe
resolved requests, preserving equivalent plain-text and single-user-message
artifacts rather than depending on case position or ownership.

Model admission checks consumed images, while storage authorization and offline
retention track all configured attachments, including complete case histories
and unused numbered fields. Image bytes remain content-addressed independently
of grid ownership and display metadata.

Judge configuration has one criteria source: a shared rubric or case-owned
rubrics on one dimension. Setup resolves that source for each cell into the
ordinary judgment task input. The scheduler and provider adapter do not interpret
criteria modes. Frontend case transitions preserve rubric association, and result
projection selects the same cell-specific criteria for scoring and display.

Input expansion combines each selected message's images with its referenced
numbered-field attachments. Attachment membership belongs to that message or
field rather than an independent parameter. Provider preparation keeps format
instructions separate from multimodal input; judging reuses the same expanded
context.

Storage upgrades and historical read projections interpret production variable
records. A shared editor-boundary conversion restores faithfully representable
production definitions as current structural drafts; capability reporting and
Edit/Fork use the same decision. Canonical admission remains separate and accepts
only current definitions. Accepted workflow inputs and immutable artifacts keep
their original payloads; presentation metadata and current-grid references remain
independent of reusable generated content.

Image uploads have independent names and ownership records. Their bytes are
SHA-256-addressed and shared across uploads and grids. SQLite links each grid to
its uploads and each upload to its content, keeping access control and shared
usage separate from physical storage. The engine loads image bytes within
generation or judging attempts; bytes never enter grid snapshots.

Content metadata owns orientation-aware image proportions, read once at upload
and backfilled from available historical bytes when storage opens. Authorized
read projections enrich references from this metadata without rewriting
immutable conversation artifacts. The shared conversation renderer uses those
proportions to reserve image frames before loading.

Committed generation can be reused by Edit/Fork when a source is accessible and
its prepared request matches the destination. A signature captures request
semantics, including message position and ordered reference content, while a
token ceiling check protects text reuse. Reuse creates a new generation task
referencing the same immutable artifact and saved usage. Judgment tasks are
always independent.

## Workflow and content execution

Creation assigns durable generation and judgment tasks before scheduling.
One browser-safe partition policy serves the form's generation count, workflow
planning, and legacy workflow reconstruction. Equivalent judged cells share a
generation task; ordinary cells keep independent generations. Persisted legacy
source identities remain authoritative during reconstruction. Cells link to
tasks, and judgments depend on committed generation output. The configuration
grouping key remains separate from the provider request signature.

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
- The artifact loader projects committed outputs and their input images into chat
  input messages. The judge adapter appends evaluation prompts and parses strict
  structured results.
- SVG rasterization uses cancellable Node workers with local WASM and bundled
  font bytes. Workers have no browser or host-resource resolver. Rendered content
  is shared within a generation task; the content executor manages its lifetime.
- The presenter exposes output readiness separately from overall cell completion.
  Cell controls and offline caching consume that boundary. Billing owns actual
  task charges and grid spending; generation usage stays separate for Cost and
  token counts.

## Output execution and delivery

The output layer owns format instructions, parsing, completed files, and
temporary previews. Website output is a bundle of validated relative paths with
an entry page. One path validator protects both stored bundles and preview
serving. Temporary previews belong to the active attempt and are cleared when
that attempt ends or the engine starts. SVG preparation is shared between
streaming preview generation and committed output storage. Content-preservation
requirements are defined in
[PRODUCT.md](PRODUCT.md#51-shared-controls-and-output-preservation).

Chat completion retains the `chat-template` storage identifier. Ordered input
messages own their user-message attachment references, and grid expansion
substitutes variables in message bodies. Generation retains attachments in live
progress but writes only roles and text into immutable conversation artifacts.
Output projection and judge artifact loading combine the artifact with the
current task's input attachments, so reused artifacts do not carry another
grid's upload IDs or filenames.

Request preparation resolves attachment IDs into input-only file parts at their
original message positions. Request preparation and artifact loading share this
chat representation. Provider-specific cache annotations stay at the request
preparation boundary.

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
identifiers. Each engine subscription owns its write buffer and retains only the
newest pending serialized snapshot until its transport drains. Closing the
subscription releases its pending state and drain listener independently of
other readers. The web process checks the viewer's session and access before
forwarding live updates. Version 2 browser streams start with a snapshot and
send recursive field changes and string appends afterward. Opaque event cursors
identify immutable baselines in a viewer-and-grid-scoped recovery cache, bounded
to 32 MiB of serialized baselines, 128 entries, and 60 seconds. Reconnecting supplies the last received
cursor and receives a delta from that baseline, or a fresh snapshot after
eviction or a web restart. Existing version 1 clients continue receiving
snapshots until they reload. Reconnecting does not restart inference.

Thinking traces are private, attempt-specific files. Active snapshots carry
accumulated thinking; completed snapshots refer to the saved trace. Reads
authorize the requested cell and resolve its generation's trace reference.
Traces are excluded from bundles and downloads.

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

Reference delivery authorizes requests before applying content-hash validators.
Public bytes can be cached immutably. The service worker owns session-partitioned
offline image storage, reuses retained bytes after successful conditional
validation, and invalidates denied or stale-session responses. Account changes
and logout clear private cached content.

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

Completed website bundles also have a self-contained offline representation.
HTML, CSS imports, static resource references, and module imports are rewritten
to embedded data URLs. The original bundle remains available as a cached ZIP.
Offline HTML documents are served at application paths under `/offline/outputs/`
with a response-level opaque sandbox and a policy that prohibits network access,
forms, and nested frames. These documents cannot read application cookies,
storage, or the parent DOM. The response policy imposes isolation before
generated code runs.

## Code ownership

- `server/app.ts` composes web dependencies and middleware; `server/routes/`
  contains browser-facing routes. `server/generation-api.ts` and
  `server/generation-client.ts` define the private process contract.
- `server/jobs.ts` owns the task lifecycle and scheduling policy.
  `server/workflow-executor.ts` owns content execution; provider preparation,
  storage, billing, and output modules keep their respective side effects.
- Grid listing queries filter ownership or public visibility in SQLite before
  counting and selecting a page. Only that page's grids are loaded for summary
  presentation, with counts and rows read in one transaction. The list APIs
  return grids, total, page, and pageSize, and validate the requested page.
- The web process embeds authorized grid-list pages in HTML from one database
  snapshot. Request-specific HTML uses HTTP no-store and varies by cookie,
  escapes script content, and permits its inline script with a CSP hash.
