# Architecture

Slopgrid separates its web application from a long-lived inference engine. Both
processes use SQLite and the output filesystem, with explicit ownership of writes
and a private API for generation commands and snapshots.

Product behavior belongs in [PRODUCT.md](PRODUCT.md), and setup, testing, and
validation guidance belongs in [DEVELOPMENT.md](DEVELOPMENT.md). This document
describes component responsibilities, data flow, and security boundaries.

## System boundaries

| Component | Owns |
| --- | --- |
| React client | Creation drafts, model selection, grid views, and browser interactions |
| Web process | Authentication, sessions, grid metadata, model discovery for forms, HTTP/SSE connections, and authorized output delivery |
| Inference engine | Admission, scheduling, provider calls, execution credentials, cancellation, retries, streams, previews, billing writes, and recovery |
| SQLite | Sessions, identities, grid configuration, cell state, revisions, reference metadata, and inference ledger |
| Output filesystem | Completed bundles, image references, thinking traces, and temporary website previews |
| OpenRouter adapter | Catalog interpretation, credit lookup, request preparation, and inference SDK integration |

### Shared design rules

- TypeScript is shared across the React client and server. TanStack Router owns
  navigation, TanStack Query owns browser API state, SSE carries live snapshots,
  and the AI SDK adapts inference requests.
- Identity providers and inference providers have separate adapters. Provider
  logic stays outside HTTP handlers and application concurrency policy.
- Persistence, encryption, access policy, and response presentation have separate
  owners. Browser snapshot types derive from the server presenter.
- Grid expansion is separate from output instructions and parsing. Website
  parsing and storage share one relative-path validator.
- Worker allocation is a pure policy separate from execution. Scheduler state is
  grouped by grid or owner lifetime, and one notification policy handles drafts.
- Shared widgets own modal, clipboard, tooltip, and editing lifecycles. Tippy
  handles tooltips, Lucide supplies icons, and React components render Markdown
  without unsafe DOM insertion.

## Web and inference processes

### Entrypoints and request handling

- `server/index.ts` starts the web process; `server/engine.ts` starts inference.
  `createApp` requires a `GenerationAPI` and never constructs a scheduler,
  recovers generation, or clears previews.
- `server/app.ts` composes dependencies and middleware. Host dispatch in
  `server/hosting.ts` runs before application parsing, sessions, and routes.
  `server/security.ts` owns browser origin checks and API rate policy.
- Routers under `server/routes/` own authentication, catalog reads, grids,
  billing, references, SSE, and application-host outputs.
- `server/frontend.ts` serves built assets in production; development uses Vite
  middleware. HTML entries are uncached, hashed assets are immutable, and missing
  assets are uncacheable. Releases retain old assets needed by open tabs.
  Vite also retains existing `dist` files during rebuilds.

### Request and viewer limits

`server/rate-limit.ts` keeps process-local counters that reset on restart.
Routes apply separate limits for their operations, while model-list GET and HEAD
requests bypass the general API limiter.

| Operation | Limit |
| --- | --- |
| Grid creation | 10 per session and 30 per client IP per hour |
| Resume | 30 per session per hour |
| General API traffic | 600 per client IP per minute |
| Capacity checks | 60 per session per minute |
| Generated outputs | 2,000 per client IP per minute |
| Website preview paths | 20,000 per client IP per minute |
| Downloads | 100 per client IP per minute |
| Browser SSE viewers | 5 connections per session and 100 globally |

Capacity responses are uncached. The browser keeps an SSE connection while a
grid can change through active or queued generation and closes it when stable.

### Private generation API

`server/generation-api.ts` defines the versioned contract. The server exposes HTTP
over an owner-only Unix socket, with no TCP listener or browser-facing route.
Commands use strict payload schemas and named parameters rather than mutable grids.

| Operation | Contract |
| --- | --- |
| `POST /v1/grids/start` | Accepts `{ gridId, sessionId, manualKey? }`; checks access, publication, credentials, and admission. An already running grid is not started twice. |
| `POST /v1/grids/pause` | Accepts `{ gridId, sessionId }`; checks ownership, cancels that grid, and returns its state. |
| `GET /v1/grids/:id` | Combines current metadata with canonical live generation state. |
| `GET /v1/grids/:id/events` | Streams newline-delimited full snapshots, beginning with current state. |
| `POST /v1/previews/path` | Resolves `{ cellId, path }` within the active preview attempt; the web process checks output access first. |
| `GET /v1/status` | Reports protocol version, instance identifier, admission state, running calls, and active grids. |
| `POST /v1/drain` | Closes admission while accepted grids continue their queues and retries. |
| `POST /v1/accept` | Reopens admission. |

- `server/generation-client.ts` checks the protocol response header and uses
  Node's JSON consumer and line reader. An AbortSignal cancels subscriptions;
  the local stream has no idle timeout or heartbeat.
- Errors have `{ code, error }` bodies. Draining and unavailable services return
  503; missing grids return 404; published-grid conflicts return 409;
  authentication failures return 401; invalid commands return 400.
- Transport failures do not automatically replay commands. A lost acknowledgement
  may represent accepted work, so a snapshot or explicit Resume reconciles it.

### Write ownership and ordered snapshots

- Creation inserts immutable grid configuration and initial cells together.
  `Store.saveGeneration` changes only generation status, interruption, and cell
  state; metadata methods change only titles, publication, or ownership.
- Every mutation allocates a monotonic SQLite revision, including live draft
  changes whose text stays in memory. Snapshots combine fresh persisted metadata
  with live cells, and clients discard older revisions.
- Publication and admission use immediate transactions so publication cannot race
  a retry. The engine writes inference calls; the web process reads the ledger.
- Engine subscriptions register before their initial snapshot in the same
  event-loop turn. Slow subscribers disconnect instead of accumulating unbounded
  snapshots.
- Browser SSE rechecks session validity and ownership, including on heartbeats.
  EventSource reconnects after a web restart and receives current drafts,
  thinking, estimates, and preview identifiers without restarting inference.
  Engine snapshots carry a `live` flag derived from queued work and unsettled
  calls, independently of visible cell statuses. Manual Pause marks cells pending
  immediately but keeps the stream live until cancelled calls settle. Settlement
  persists billing and cell state, advances the revision, and emits the final
  snapshot before the browser closes its stream. Reloads and reconnects receive
  the same engine-derived flag, and streams reopen when work starts again.

### Updates and recovery

- A soft update replaces web code and frontend assets without changing the running
  engine's immutable release or dependencies.
- A machinery update closes admission and waits for accepted grids and all
  unsettled calls, including cancelled calls, without a cancellation timeout.
  Queued work and retries continue, preserving memory-only credentials until
  completion or pause.
- Termination signals request the same drain. A forced kill can interrupt work.
  Only engine startup performs interrupted-grid recovery and preview cleanup;
  opening a store or restarting the web process does not.
- Recovery marks running grids paused and interrupted cells pending. It does not
  launch replacement requests. Resume requires an owner-authorized command.
- Protocol, storage, engine, and incompatible dependency changes require a
  compatible machinery update. Admission can reopen if maintenance is cancelled.

## Creation, catalogs, and request preparation

### Browser drafts and model discovery

- Creation initializes sessionStorage drafts synchronously. The saved form layout
  is present when TanStack Router restores history-entry scroll positions.
- `server/model-catalog.ts` loads model listings and image endpoint details into
  a shared snapshot before serving frontend pages. Concurrent reads share loading;
  refresh runs five minutes after the previous refresh finishes.
- Failed refreshes retain the previous snapshot. Failed image-detail lookups keep
  previous details when available, and catalog shutdown stops the timer.
- The frontend bakes `window.__SLOPGRID_MODELS__` into cached HTML using serialized
  JSON and a CSP-authorized content hash. `src/model-catalog.ts` reads it
  synchronously; a page reload picks up newer metadata.
- Model-list GET and HEAD requests use the same snapshot and bypass API rate
  limiting. The web and inference processes have separate provider caches.
- Selection requires an explicit model choice. Badge order lives in axis values,
  so drafts, swaps, and saved inputs preserve it. Pointer capture and keyboard
  movement reorder badges; insertion finds the nearest selected model in the
  unfiltered catalog, resolving ties toward the earlier entry.
- Shared pricing components show text rates per million tokens and image rates
  in their published units, with provider and request-charge details in tooltips.

### Input expansion and aliases

- `server/domain.ts` validates inputs, expands their Cartesian product, and
  substitutes prompt variables literally. Axis values are nonempty and distinct.
  Prompts, axis values, model IDs, grid size, and requested parallelism have no
  application size ceiling; the public JSON parser has no byte ceiling.
- `server/model-resolution.ts` follows published `alias_target.slug` chains
  before saving or expanding inputs and collapses duplicate resolved selections.
- Catalog aliases without a published target retain their IDs through inference,
  retry, and Edit/Fork. Cycles and unknown latest aliases are rejected.
  `canonical_slug` supports moving-alias warnings; a differing canonical slug
  alone does not establish an alias.

### Provider calls and token budgets

- `server/provider.ts` owns catalog and credit interpretation.
  `server/inference.ts` makes one streamed text request or one dedicated image
  request per cell attempt.
- `server/http.ts` supplies the shared transport for discovery, credits, OAuth
  exchange, and inference. Connection, header, and body timeouts are disabled;
  abort signals carry cancellation without application inference deadlines.
- `server/generation-budget.ts` converts a cell's monetary allowance into an
  explicit output-token ceiling using catalog prices, conservative input cost,
  the completion limit, and remaining context. Matching provider-price
  constraints accompany the request. Retries receive a fresh allowance.
  The input estimate uses UTF-8 prompt and system bytes plus 256 framing tokens;
  the remaining budget divided by output-token price is rounded down. Free
  output uses the model ceiling, and missing pricing or context fails the cell
  before dispatch. The SDK receives `maxOutputTokens`, serialized as
  `max_tokens`, and `provider.max_price` in USD per million tokens.
- Budget configuration is stored once in grid input and derived into cells.
  Images use their dedicated API without the text-token budget.
  Input validation requires a positive finite budget for text formats. Image
  inputs preserve valid budgets and normalize missing or invalid budgets to $3
  for numeric storage metadata; that value does not limit image inference.
- `server/model-pricing.ts` parses catalog prices and resolves conditional prompt
  and UTC schedule overrides. Preparation evaluates rates at call time.
  Overrides use strict prompt thresholds, UTC windows including midnight
  wrapping, weekday restrictions, and later-entry precedence per price field.
  `server/generation-instructions.ts` shares format instructions with the browser
  without importing server-only output storage code.
- `server/cost-estimates.ts` shares per-cell estimates between the form and
  admission and computes dispatch-order worker recommendations for admission. Complete estimates use the
  generation budget calculation; incomplete estimates use $3 for scheduling and
  remain unknown in the per-model budget warnings. The form groups expanded cells
  by model and displays the highest calculated maximum for reduced allowances,
  retaining unknown estimates alongside calculated warnings. Estimation metadata stays outside
  effective-request signatures.
- Reasoning metadata distinguishes explicit efforts, unrestricted selection,
  mandatory reasoning, unavailable selection, and unpublished capabilities.
  Model default omits configuration; None sends `reasoning.enabled: false`;
  explicit efforts use `reasoning.effort` with required-parameter routing.

### Compatibility and image settings

- `server/compatibility.ts` classifies combinations as supported, unsupported,
  or unknown. Compatibility is advisory and does not gate generation or retry.
- Thinking tables use selected models as rows and efforts as columns, independent
  of generation axes. Image tables use models and the selected values of each
  parameter. The creation form attaches each table to its corresponding input.
- `server/image-settings.ts` derives aspect-ratio, quality, background, and resolution choices from the public image-request enum exports in `@openrouter/sdk`, while keeping Auto ordering and custom pixel-size validation local. It also owns reference metadata types. Direct ES module imports let Vite tree-shake unused SDK code from the frontend; the shared enum module also contains schema initializers, so some schema helpers remain in the bundle.
- Grid input stores shared `imageSettings`, ordered `inputReferences`, and
  reference-axis groups. Validation removes overridden shared settings, empty
  shared references, and unselected groups; expansion applies axes over defaults.
- One normalization function removes unspecified and Auto values before
  compatibility and request preparation, giving equivalent requests identical
  signatures. Custom dimensions serialize as pixel-size strings; incomplete
  pairs remain drafts and fail input validation.
- `Provider.imageEndpoints` caches capabilities, provider names, and prices for
  five minutes, shares pending reads, and evicts failures. Provider names must be
  nonempty and pricing arrays explicit; an empty array means unpublished prices.
- Image compatibility requires one endpoint to support the complete combination.
  Minimal conflicting parameter subsets receive warnings, while unrelated
  settings do not. Missing metadata remains unknown, and size/aspect conflicts
  affect both parameters.

## Scheduling and credentials

### Admission and concurrency

- `server/inference-policy.ts` checks credits before creation and Resume.
  Image generation below $3 requires explicit continuation through the shared dialog.
  Fully reused grids skip the inference balance check. Lookup failures block new
  inference while existing calls continue.
- `GET /api/inference-capacity` recommends at least one worker using balance
  divided by $0.40 for images or the $3 text fallback when cell data is absent.
  The form uses automatic selection, submitting the recommended image count and
  omitting the text count. Admission computes automatic counts from resolved unfinished
  cells after artifact reuse and on Resume, summing individual costs in order.
  Rejected creation removes newly copied artifacts and thinking traces.
  Unavailable manual-key balance and key-limit data yield one worker.
- Automatic text selection omits `parallelWorkers`; existing saved explicit values
  survive Resume. Edit/Fork submissions use automatic selection.
  Each accepted start sets the session limit from that value or the recommendation.
- `server/worker-allocation.ts` selects the eligible owner with the fewest active
  cells, breaking ties by allocation history. It applies owner limits and the
  shared `WORKERS_MAX` cap, which defaults to 100.
- Jobs also enforces each grid's own worker limit. Active counts derive from
  running calls, including unsettled cancellations. Capacity is not reserved,
  and fairness never cancels existing work.

### Execution, pause, and failure handling

- `server/jobs.ts` coordinates scheduling and execution. Each live grid has one
  private runtime record containing its canonical grid, execution owner,
  credentials, reference loader, retry counts, and notification timer. Admission
  queries running state without accessing mutable scheduler collections.
- `server/cell-lifecycle.ts` owns the cell-field transitions for queuing, starting
  an attempt, clearing retries, and discarding streamed progress. Completed cells
  are skipped on Resume, and saved thinking remains available until a replacement
  attempt starts.
- Running calls retain their dispatch owner and cancellation controller separately
  from grid runtime, which Resume can replace. Owner allocation history is removed
  when idle, while cooldowns remain until expiry so Resume cannot bypass backoff.
- Manual pause stops queued cells, aborts active requests, and discards drafts.
  Slots remain occupied until cancelled calls settle; late chunks and results
  cannot change retried or completed cells.
- `server/failures.ts` extracts messages, codes, retry guidance, and transient
  classification from HTTP and streamed errors. Messages and codes persist;
  retry flags and cooldowns remain in memory.
- HTTP 429 responses and in-flight-budget 402 responses carrying valid
  Retry-After guidance return cells to pending and impose a session-wide cooldown. A single
  timer wakes expired cooldowns; up to five retries use backoff, jitter, and the
  longer server-requested delay.
  Backoff starts at one second and doubles with up to 50% jitter, capped at thirty
  seconds. Retry-After accepts seconds or an HTTP date. Waiting cells release
  slots, and Resume honors an unexpired cooldown. SDK automatic
  retries are disabled so the scheduler owns whole-cell retry attempts.
- Permanent billing failures pause queued grids for that owner while active
  calls finish, including 403 errors identifying exhausted key, workspace, or
  guardrail budgets. Other permanent failures affect only their cell and release its
  worker for remaining work.
- State persists before notification. Draft notifications share a per-grid
  300 ms throttle, while cell transitions emit immediately. Idle owner state is
  removed after grids pause or finish.

### OpenRouter credentials

- OAuth state and PKCE verifiers stay server-side with a ten-minute exchange
  deadline. Returned keys are encrypted with AES-256-GCM through
  `server/encryption.ts`.
- Manual keys live in browser localStorage and synchronize across tabs.
  `server/manual-keys.ts` extracts bearer credentials and delegates validation
  to the provider; reads and SSE continue to use the ownership cookie.
- Manual credentials take precedence over OAuth. Selecting OAuth or disconnecting
  clears the local manual key. Credit lookup uses the lower available account
  balance and key limit, falling back to either available value.
- The engine retains manual keys only in per-grid memory while work is queued or
  running. It drops them on pause or completion; request closures retain them
  until settlement. Resume after pause or restart requires resubmission.
- Closing a tab does not cancel queued work. Manual keys never enter SQLite,
  output files, billing entries, or grid snapshots.

## Persistence, billing, and reuse

### Storage ownership

- `server/store.ts` uses SQLite with WAL and foreign keys. Configuration is
  stored once; per-cell prompts and settings are reconstructed from it.
  Cell IDs and positions are relational columns rather than duplicated JSON.
- `server/database.ts` creates an empty database in an immediate transaction and
  checks `user_version`. Schema version 9 is current; version 8 upgrades by
  adding reference-image metadata without changing existing records. Other
  nonempty schema versions are rejected.
- `server/files.ts` stores bundles under cell IDs and images as binary files.
  Complete bundles are staged and renamed into place before completion is saved.
  Retries replace interrupted writes; metadata changes never rewrite artifacts.
- Output lookup joins the cell primary key to its grid. Generated bodies remain
  outside SQLite and snapshots. Encryption and response presentation are separate
  from storage.
- SQLite also stores encrypted OAuth credentials, users, and identities keyed
  by provider and subject. There is no automatic database or completed-output
  retention cleanup. Temporary website previews are cleared at engine startup
  and when an attempt ends.

### Inference ledger and live estimates

- `server/billing.ts` records each actual upstream attempt before dispatch,
  retaining status, timestamps, provider identifiers, token usage, charges,
  finish metadata, and errors. Retries create new entries; cancelled and failed
  calls retain reported charges. Startup marks unfinished entries interrupted.
- The ledger excludes prompts, outputs, credentials, and headers. Cell usage
  derives from the latest call. Finish metadata stays in the ledger and is
  omitted from grid and billing presentation.
- Text completion policy accepts successful stops and records usage before
  reporting incomplete responses. A scoped fetch wrapper preserves image costs
  omitted by the installed adapter.
  Only `stop` is a successful text finish reason. Images retain reported finish
  metadata when available; otherwise a successful image response establishes
  completion. Billing returns 50 calls per page and totals all reported charges,
  including failed and retried calls, while missing charges remain unknown.
- Streaming estimates use catalog rates and request fees, approximating one
  token per four UTF-8 bytes plus eight framing tokens. Exposed thinking counts
  toward output estimates; hidden reasoning and provider tokenization can differ.
- `estimatedUsage` exists only in engine memory and snapshots, and is cleared
  on terminal transitions or a new attempt. Final reported usage replaces it.
- Grid cost combines successful outputs with running estimates. Owner spending
  includes all ledger calls and estimates only for running calls without reported
  cost; a reported zero is authoritative.
- The engine computes `spentUsd` with each snapshot. It is not persisted as grid
  metadata, and the presenter removes it for non-owners. Billing reads are
  ownership-filtered and paginated.

### Artifact provenance and reuse

- `Provider.prepare` and `server/prepared-inference.ts` build the serializable
  effective request used by inference and reuse. Text preparation includes
  resolved pricing, instructions, token limits, reasoning, routing, and schemas.
- Signatures hash canonical object keys while preserving array order, and include
  format, budget, adapter version, and ordered image content hashes and media
  types. Estimator-only pricing stays outside the signature. Adapter semantic
  changes require a revision bump.
- Successful cells persist a signature and complete file inventory after storage.
  Historical cells without provenance remain readable but generate afresh.
- Creation validates source visibility and normal access/admission checks.
  `server/artifact-reuse.ts` matches completed source cells in grid order and
  copies complete artifacts and thinking under fresh identifiers.
- Each source bundle is read once, with at most one held in memory. Source-read
  failures and preparation errors are cache misses; destination writes, database
  failures, and unexpected preparation errors propagate.
- Copies retain provenance, media type, and usage but create no inference ledger
  entries. Destination ownership controls access independently. All-copy grids
  complete immediately; mixed grids schedule only unfinished cells.
- Source identifiers and reuse selection live outside generation input in the
  browser draft. Edit/Fork initializes reuse as selected.
- Reference loaders share pending reads and hashes within one reuse operation or
  engine execution, preserve order and duplicates, and evict failures. Web and
  engine loaders have independent lifetimes.

## Output protocols and previews

### Text and website outputs

- `server/output-format.ts` owns generation instructions and completed-output
  parsing. SVG is stored verbatim; Markdown uses its original source.
- Websites use `{ files: [{ path, content }] }` with safe relative paths, unique
  entries, and a required `index.html`. Any file extension and extensionless
  assets are allowed, and all files are served statically. Generation has no
  application output-byte or bundle-file-count limit.
- Models advertising structured output receive the shared strict schema with
  compatible routing. Others receive the same shape through prompting. Both use
  the same stream decoder and direct final JSON parsing, with no silent downgrade.
- `server/partial-website.ts` handles incomplete strings and split escapes.
  `server/website-previews.ts` atomically updates temporary attempt directories,
  coalesces bundle refreshes, and clears them on cancellation, retry, completion,
  or engine startup.
- Preview identity stays in memory. Snapshots carry versioned website URLs rather
  than bundle text; isolated HTML hosts serve relative preview assets.

### Browser rendering and state preservation

- SVG drafts are locally completed for image decoding, and only valid decoded
  candidates replace the last preview. Repairs never alter stored SVG.
- Markdown drafts and saved source share a mounted React renderer
  (`react-markdown` and `remark-gfm`). Completion fetches raw source without
  remounting the document or losing scroll state.
- `shared/markdown.tsx` also renders direct output pages. Raw HTML stays escaped;
  Vite uses the entity decoder's lookup-table implementation rather than DOM
  insertion. The renderer ships in the main bundle.
- Website previews keep the visible iframe while a second loads, coalescing
  intermediate updates. `src/grid/frame-scroll.ts` transfers viewport and panel
  offsets through a MessageChannel before swapping, with a timeout if the old
  document stops responding.
- Scroll restoration matches element IDs or structural paths and clamps offsets.
  The same handoff replaces streaming previews with saved outputs. Private
  frames wait for both authorization bootstrap and document loads.
- Output and thinking views stay mounted across toggles. The workspace overlay
  expands either an output or reference image while preserving the hidden table.
  Collapse restores focus, zoom, sizes, and scroll offsets.
- Generated HTML forwards unhandled Escape to its application parent; only the
  expanded view's own iframe windows can close that overlay.
- Markdown code and source views use bundled DejaVu Sans Mono. Direct output
  pages embed the font as data under their sandbox CSP; the license accompanies
  the asset.

### Thinking traces

- The inference adapter reads exposed thinking from raw OpenRouter events,
  including reasoning interleaved after output. Readable `reasoning_details`
  supersede duplicate legacy text, and encrypted blocks are omitted.
- Image responses retain exposed thinking when present. Capture does not request
  hidden reasoning or change the selected effort.
- Jobs writes attempt-specific private trace files before emitting snapshots.
  New attempts clear the current identifier; prior files remain separate.
  Partial traces survive failure, pause, and restart.
- A length-limited text response with no output and a fully consumed reported
  reasoning budget raises the specific thinking-exhaustion error after recording
  usage. Other incomplete responses use the normal failure path.
- `/outputs/:id/thinking/:attempt` checks ownership and the current attempt ID.
  Trace files are excluded from bundles, downloads, and isolated HTML hosts.
- Attempt-specific query keys prevent stale fetch replacement. Wrapped trace
  previews retain their draft while saved traces load and follow appended text
  only while the user remains at the bottom.

## Image references

- `src/create/reference-files.ts` keeps selected bytes in IndexedDB while drafts
  store identifiers and filenames. Blob previews are revoked on unmount.
- Generate validates the draft, uploads selected local files, replaces local IDs,
  and then creates the grid. Successful uploads are reused on submission retry;
  unmount aborts uploads, and failures retain selected files.
- `server/routes/references.ts` accepts PNG, JPEG, and WebP with a 20 MiB per-file
  limit and verifies signatures rather than trusting filenames or browser MIME.
  Invalid input returns 400; storage failures return 500 without storage details.
- `server/image-references.ts` owns persistence and access. SQLite stores metadata
  and ownership; separate reference directories store bytes. Login claims
  anonymous references along with grids.
- Creation checks every selected reference and discards unused groups. Reads
  require ownership or an accessible owned/published grid using the reference;
  unused uploads remain private.
- The engine loads ordered bytes, media types, and hashes. Data URLs are created
  only at SDK dispatch; bytes never enter grid metadata or SSE.
- Shared references and reference axes use the same upload, access, and inference
  paths. Edit/Fork retains stored IDs, while reference images remain distinct from
  generated cells.

## Identity, ownership, and publication

### Authentication and sessions

- Users start with an anonymous browser session. GitHub adapters identify accounts
  by provider and immutable numeric user ID, refreshing display names on sign-in.
  GitHub tokens are discarded after profile retrieval.
- GitHub credentials are required at startup. Identity and OpenRouter OAuth
  attempts remain separate, with session-bound single-use state, ten-minute
  expiry, PKCE, and validated local return paths.
- `oauth4webapi` generates PKCE values. Octokit's OAuth and request SDKs perform
  GitHub authorization and profile lookup through the shared transport;
  OpenRouter's custom exchange stays in its provider adapter.
- Sign-in atomically claims anonymous grids and rotates the cookie. Sign-out
  rotates it again, removing account access while retaining browser-local
  OpenRouter state.
- Stable anonymous identity survives rotation. Running work retains the initiating
  execution owner; Resume from another browser uses that browser's credentials.
- Sessions have no age-based expiry. Application and output cookies use rolling
  400-day maximum ages. Session readers renew application cookies, while
  side-effect-free output reads do not create sessions or set cookies.

### Access and metadata

- `server/grid-policy.ts` centralizes ownership and publication checks.
  Account ownership takes precedence over anonymous origin after claiming.
  Response presentation omits ownership identifiers.
- Draft author data uses the current account profile. First publication freezes
  public attribution; historical publications without attribution remain
  Anonymous.
- Publication requires every cell to be complete or failed and permanently locks
  generation inputs and outputs. Owners may edit titles and promote unlisted
  grids to public, but cannot reverse publication.
- Public listings include only publicly listed grids. Unlisted grids remain
  readable by link. Mutations require ownership and reject cross-origin browser
  requests.
- `POST /api/grids/:id/publish` accepts `{ visibility }`, and
  `GET /api/grids/public` returns public summaries newest first without ownership
  identifiers or cell data. Summary APIs include output format and visibility.
  The publish dialog saves successful confirmation suppression under
  `slopgrid-skip-publish-confirmation` in localStorage.
- Titles are separate optional metadata. The title route validates length,
  updates only title and revision, obtains a fresh engine snapshot, and notifies
  subscribers without changing generated files.

## Output isolation and authorization

### Application-host outputs

- Images, SVG, and Markdown use `/outputs/:id`, with authorization before file
  or download metadata access. Published outputs need no session.
- Images are binary responses. SVG uses image rendering and a restrictive CSP;
  Markdown escapes raw HTML. Direct output pages have a sandbox without script
  permission and set no cookies.
- The HTTPS application cookie is host-only and uses the `__Host-` prefix.
  Generated HTML cannot be fetched through application-host output routes.
- Published images and SVG use immutable public caching. Private versions use
  immutable private caching with `Vary: Cookie` and mandatory revalidation once
  stale. An unchanged cookie can still reuse fresh cached bytes without a server
  check; other output routes and errors use `no-store`.
- Downloads share access checks. Websites stream ZIP archives through `fflate`;
  other formats return original files. Clipboard image copying converts to PNG.

### Isolated HTML hosts

- Each cell has a random 192-bit identifier. Its HTML host combines that ID and
  an environment-configured hyphen-prefixed suffix in one wildcard-covered
  DNS label. Matching requires the exact configured pattern and cell ID.
- Host dispatch precedes application middleware. HTML hosts expose only validated
  files from their bundle or active preview; application APIs and other output
  formats are inaccessible there.
- CSP uses a whole-label hostname wildcard. Generated pages run in an opaque
  sandbox without `allow-same-origin`, allowing scripts and static assets but
  blocking connections, forms, and cookie access, including in direct tabs.
- `server/website-html.ts` rewrites served private HTML for credentialed loading
  of scripts, stylesheets, and module imports using parse5. Stored files and
  downloads remain unchanged.
- Authorized private resources permit credentialed CORS from the sandbox's null
  origin; a null origin alone grants no access. Public resources use
  credential-free CORS.

### Private iframe handshake

`server/output-access.ts` bridges authorization without exposing the application
cookie to generated hosts.

1. The application entry route checks the live session, ownership, and requested
   path, then issues an in-memory grant bound to that session, cell, and path.
   Grants expire after thirty seconds and have global and per-owner caps.
2. Navigation to `/__session/<grant>` on the output host rechecks access, sets
   an encrypted host-only output cookie, and serves trusted bootstrap code.
   Navigation leaves the grant available for the second phase.
3. The bootstrap performs a credentialed fetch to the same endpoint. This sets
   the cookie in the sandbox's subresource partition, consumes the grant, and
   returns 204 before navigation to the generated document.

- Both phases enforce grant expiry and cell binding. Non-navigation clients
  without the sandbox's null origin receive a redirect after redemption.
- Navigation and opaque sandbox resources can use different cookie partitions;
  Chromium includes cross-site ancestor state in its partition key. The second
  phase establishes the correct partition.
- The output cookie is Secure, HttpOnly, SameSite=None, host-only, and partitioned.
  It contains encrypted cell and application-session IDs, not a permanent grant.
- Every private asset request rechecks cell scope, session validity, and current
  ownership before reading files or enabling CORS. Session rotation or deletion
  revokes access even if the output cookie remains.
- Each signed-in owner session can establish its own authorization. Revoking one
  session does not revoke another, and knowing the output URL grants no access.
  Published outputs bypass the handshake.

### Direct HTML navigation and trusted bridges

- Private top-level navigation without an output cookie redirects through the
  application entry route. Redemption sets the navigation cookie and redirects
  back to the requested output URL.
- At that URL, a fresh grant and bootstrap establish the current document's
  subresource cookie. The bootstrap writes generated HTML into the same document
  to retain its opaque partition and URL.
- A `connect-src 'none'` CSP meta policy precedes generated scripts, so bootstrap
  connection permission never extends to generated code. Removing the meta
  element does not undo the policy. Embedded serialized HTML escapes less-than
  characters.
- Reloading or following another HTML file repeats authorization. Embedded frames
  use the two-phase flow above, and stored files and downloads stay unchanged.
- The served scroll bridge runs before generated scripts, accepts requests only
  from its immediate parent at the application origin, and replies through a
  MessagePort. It is inactive in direct tabs and adds no authorization privileges.

## Frontend ownership

- `src/main.tsx` mounts providers, `src/router.tsx` defines routes, and
  `src/layout.tsx` owns navigation and the grid-header portal.
- Pages live in `src/pages/`, creation controls and drafts in `src/create/`,
  and shared dialogs and connection controls in `src/components/`.
- The creation page owns rendering and tooltips. `src/create/draft.ts` owns
  draft persistence and edits, including format defaults and uploaded-reference
  replacement. `use-create-form.ts` combines draft edits with model choices,
  budget estimates, capacity checks, and generation readiness.
- `src/create/use-create-submission.ts` owns submission validation, upload
  activity and cancellation, inference errors and low-balance confirmation,
  and navigation after creation. Successful uploads replace local references
  in the draft and remove the corresponding local files so submission retries
  can reuse the uploaded references.
- `src/grid/use-grid.ts` owns grid queries, SSE state, and editing mutations.
  Grid headers, output tables, and cells have separate components.
- Shared inference mutations own credentials, pending state, failures, and
  low-balance confirmation for creation and Resume. Publishing owns its own
  mutation rather than duplicating errors inside the dialog.
- `src/components/editable-title.tsx` owns editing interaction, pending state,
  and errors; callers own validation and persistence.
- `src/grid-resize.ts` owns table dimensions, persisted locally per grid.
  `src/zoomable-grid.tsx` coordinates viewport fitting, touch scaling, and scroll
  anchors; `src/grid-pan.ts` owns mouse panning outside content and controls.
- `src/contained-image.tsx` sizes the image element to its natural aspect ratio
  so surrounding space remains available for panning.
- Theme bootstrap applies stored preference before rendering. The React provider
  follows system changes, persists overrides, synchronizes tabs, and updates
  browser theme metadata; generated canvases retain their own appearance.

### Bundled assets and dependencies

- Markdown uses DejaVu Sans Mono in WOFF2 format, including full-block and
  box-drawing glyphs. Its Bitstream Vera license ships as
  `public/fonts/DejaVu-LICENSE.txt`. Direct Markdown pages render on the server;
  `?raw=1` returns the original source.
- Lucide interface icons use the ISC license with MIT notices for icons derived
  from Feather; `public/lucide-LICENSE.txt` is copied into the build. The custom
  5x5-cell project SVG is shared by the wordmark and favicon. OpenRouter uses its
  official brand asset, and GitHub sign-in uses the unmodified white Invertocat
  SVG from [GitHub's logo assets](https://brand.github.com/foundations/logo).
- SDK definitions use direct ES module imports for Vite tree-shaking. The
  optional OpenRouter SDK postinstall catalog check is disabled in
  `pnpm-workspace.yaml`; published enum definitions need no install-time generation.

## Browser test process ownership

- `tests/test-server.ts` forks `tests/e2e-process.ts`, passes configuration via
  the environment, and waits for IPC readiness. The fixture owns its inference
  child, and both mock and real fixtures mount the application frontend router.
- Closing parent IPC shuts down the fixture and engine, including after unexpected
  worker exits. Teardown awaits process exit before removing fixture data.
- Test scenarios and runtime validation belong in
  [DEVELOPMENT.md](DEVELOPMENT.md#validation).
