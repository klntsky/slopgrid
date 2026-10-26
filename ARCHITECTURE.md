# Architecture

Slopgrid separates browser presentation, authenticated web access, durable
workflow execution, provider integration, and content storage. This document
describes responsibility, state ownership, and trust boundaries. Product
behavior belongs in [PRODUCT.md](PRODUCT.md), while setup and operational
commands belong in [DEVELOPMENT.md](DEVELOPMENT.md).

## Process boundaries

The web process owns HTTP requests, sessions, grid metadata, model catalogs,
and authorized output delivery. It delegates inference to a long-lived engine
over a private process interface. Browsers cannot address that interface.

The engine owns accepted work, scheduling, provider requests, cancellation,
usage recording, and recovery. Replacing the web process does not replace the
engine or transfer ownership of active inference to a request handler.

The browser owns editor interaction, presentation preferences, and local drafts.
Its cached state supports display and recovery but does not authorize server
mutations or determine durable execution state. TanStack Query owns read retries,
connectivity suspension, failure state, and request cancellation when a grid is no
longer observed. Grid recovery enforces request deadlines and shared server
cooldowns; the HTTP transport preserves response status and cooldown metadata even
when an error body cannot be read. Live streams own cursor recovery before query
fallback and cancel redundant reads before publishing fresh state, without
resubmitting server mutations. Browser queries own the lifetime and freshness of
completed output bodies. Development and test runtimes own independent storage
and process resources.

Each browser listing owns its transient layout and pagination position.
Page navigation preserves the active controls without changing server-side
pagination state or constraining the height of individual grid rows.

Deployment orchestration belongs to [ops/](ops/ARCHITECTURE.md). The development
launcher owns only its development runtime; neither it nor application request
handlers own release promotion.

## State and persistence

The database owns identities, sessions, account favorites, grid configuration,
workflow state, content references, and the inference ledger. The artifact store owns generated
bodies, uploaded image bytes, and thinking traces. Access checks select content
through authorized domain references rather than browser-supplied storage paths.

The storage initialization boundary owns migrations before normal runtime use.
Historical input handling stays there, while runtime readers consume the current
canonical representation. Accepted execution inputs and immutable generated
content remain separate from editable configuration and presentation metadata.

Account favorites belong to the web process, separate from shared grid execution
state. The favorites boundary scopes reads and writes to the authenticated
account and applies grid access policy before exposing content. Browser
membership caches support presentation; they do not grant grid access or own
durable favorite state.

The web process prepares personalized initial listings and the public session
summary in one database snapshot. The frontend hydrates its query cache before
rendering, using that same session identity for subsequent favorites queries.

Each application document owns its favorite-change subscription and recovery
lifecycle. Browser notifications request authorized rereads rather than carry
favorite membership or account identity. The query reconciliation boundary
prevents pre-change reads from replacing refreshed favorite state, while the
backend remains the authority across tabs.

Generation commits a durable reference only after its artifact is installed.
Live drafts and estimates belong to the engine until committed. The persistence
boundary coordinates provider-call records and task transitions so recovery
does not interpret an uncommitted result as completed work.

The ledger records actual provider calls independently of the grid's displayed
generation cost. Billing reads follow grid ownership. Credentials and generated
content do not belong in ledger diagnostics.

## Input admission and workflow planning

The editor permits incomplete drafts. Authoritative admission validates and
expands those drafts into concrete cell inputs before durable creation and
workflow planning. Advisory form feedback shares validation policy but does not
grant generation admission. Creation identity belongs to this transaction
boundary, allowing a replayed submission to resolve to its existing grid.

Case configurations own aligned parameter values, while judge rubrics own their
criteria. Input expansion resolves the selected configuration and referenced
attachments once. Execution consumes accepted concrete inputs without
reinterpreting editor ownership or performing another setup-validation pass.

Workflow planning assigns durable generation and judgment tasks and their
dependencies. Cells project task results for presentation. Shared or reused
generation refers to immutable content; judgment remains an independent task
with its own execution and billing.

## Scheduling and content execution

The scheduler owns worker allocation, attempt identity, admission, retries,
cancellation, and settlement. The content executor owns generation and judgment
strategies, progress, reference loading, and artifact installation. Keeping
these responsibilities separate prevents output-format details from determining
worker or persistence policy.

Provider adapters own catalog interpretation, request preparation, upstream
transport, and usage interpretation. Output strategies may coordinate several
provider calls within one task attempt. Every call crosses the same cancellation
and durable billing boundary.

The presentation boundary projects current task state and authorized content
without becoming an execution authority. Live-update transport and browser
reconciliation preserve ordering independently of provider streaming. Recovering
a connection does not create a new inference request.

## Identity and output isolation

Application identity and inference-provider authorization are separate concerns.
Grid policy centralizes ownership, publication visibility, and mutation access.
Signing into an account changes ownership through that policy rather than
copying inference credentials between browsers.

Live generated websites run on independent output origins. Host dispatch keeps
those origins outside application routing, and application cookies and site
data remain separate. Output content retains browser capabilities; the browser
enforces cross-origin access and permission prompts.

Private website delivery crosses an authorization bridge: the application
checks the viewer and requested output, then the output origin establishes
scoped access tied to the live application session. Asset requests recheck that
scope, so an output URL or previously issued cookie is not an independent grant
to another viewer's content. Browser messaging used for preview interaction
does not grant application or filesystem access.

The service worker owns session-partitioned offline content and coalesces grid
reads for foreground queries and offline retention. It preserves a shared
upstream read while another consumer needs it and propagates cancellation when
the last consumer releases it. Only server-authorized responses can populate
the cache; client completion notifications cannot supply cached grid contents.
Cached website representations served from application paths use an opaque
sandbox to separate generated code from application cookies, storage, and the
parent document. Offline retention does not replace the server's authorization
policy.

## Shared content ownership

Uploads, grids, and tasks can reference shared physical content. Their domain
ownership and display metadata remain separate from stored bytes. Artifact
reuse and data administration preserve that separation, and content cleanup
checks remaining references before removing shared bytes.

Operations owns offline transfer, backup, and administrative deletion. Application
storage owns canonical data and migration, while authorization remains attached
to the destination grid and viewer rather than to physical content identity.
