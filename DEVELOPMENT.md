# Development

This guide covers setup, configuration, operations, and validation. Architectural
responsibilities and runtime behavior are described in [ARCHITECTURE.md](ARCHITECTURE.md).

## Requirements and setup

Use Node.js 22.12 or newer and pnpm 12.4.2. Browser and runtime fixtures use OpenSSL to generate temporary HTTPS certificates. Supply `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` through private runtime configuration before starting the app; either missing or empty variable prevents startup. SQLite uses `better-sqlite3`; environments without a matching prebuilt binary need Python and a C/C++ build toolchain. Native build permissions are in `pnpm-workspace.yaml`.

```sh
pnpm install
pnpm exec playwright install chromium firefox
pnpm dev:engine
# In another terminal:
pnpm dev
```

Open http://localhost:3000. Chromium resolves HTML output hosts ending in `.localhost` to loopback, and OpenRouter OAuth supports localhost callbacks. Preserve the development database and encryption key under `.data/` to retain sessions.

## GitHub integration verification

`pnpm test:e2e:github` runs against real GitHub and OpenRouter. Supply GitHub client credentials and the normal real OpenRouter test credential source. Set `GITHUB_INTERACTIVE=1` to complete GitHub login and any two-factor challenge in a visible browser, or provide `GITHUB_BROWSER_STATE` referencing a private Playwright storage-state file containing an authenticated GitHub browser session. Keep this file outside the repository. Register the callback using the test application origin followed by `/api/auth/github/callback`. The runner rejects an occupied test port before launching.

The test creates and generates an anonymous grid, signs in through GitHub, verifies claiming and publication attribution, signs in through GitHub in a separate browser context, checks account access and billing, and signs out. It uses no mocked OAuth or inference endpoints. Missing credentials, authorization failure, and provider errors fail verification rather than silently skipping it. Unit identity tests exercise the real app and database with mocked GitHub token and profile responses, including claiming active grids, session rotation, and callback replay rejection. They do not authenticate with GitHub.

### Creating a GitHub browser session locally

With Node.js installed on your computer, open a terminal in a private directory outside the repository and run:

```sh
umask 077
npx playwright install chromium
npx playwright codegen https://github.com/login --save-storage=github-state.json
```

Sign in to GitHub in the browser that opens and complete any two-factor authentication. This browser uses a separate session from your usual browser. After signing in, close the browser so Playwright saves the authenticated session to `github-state.json` in the current directory.

Set `GITHUB_BROWSER_STATE` to the absolute path of this file when running the GitHub integration suite. Keep the file private and outside Git because it contains authentication cookies, and recreate it when the session expires. See [Playwright's authentication-state documentation](https://playwright.dev/docs/codegen#preserve-authenticated-state).

## Frontend builds

Frontend line-count comparisons cover `src/`, `index.html`, and
`public/theme.js`, formatted with the repository's Prettier configuration.
Dependencies, build output, retained assets, and test artifacts are excluded.
Frontend validation covers the browser suites and frontend-related unit tests.

Connection coverage holds the session response, fails it, and retries through
the interface before verifying authorization and navigation to Settings.

Catalog checks cover combined model and image-detail loading, periodic server refreshes with retained snapshots after upstream failures, unrestricted cached model-list reads, and HTML bootstrap execution under the page CSP. Browser coverage checks model selection, pricing, and compatibility without model API requests, including after navigation and reload.

When changing SDK imports or upgrading the SDK, compare production JavaScript sizes and retained modules on staging to catch accidental inclusion of unused client code.

When browser tests load a runtime environment file, set `FRONTEND_PATH` explicitly to the candidate's `dist` directory so they exercise the candidate build.

Frontend serving and retained assets are described under [process boundaries](ARCHITECTURE.md#process-boundaries).

## Validation

### Test design

1. Use pnpm and Playwright, with real-provider browser suites separate but enabled in the default full run. Exercise the normal manual-key flow with a cheap or free model and cover structured website streaming with an explicitly selected capable model.
2. Assertions enforce complex behavioral properties: state transitions, persistence, ownership, recovery, and component interactions. Assert on UI text only when it depends on application logic, such as a computed value or state-dependent message. Exclude static copy assertions, trivial assertions, constant checks, CSS appearance tests, and checks that merely mirror implementation.
3. Group independent browser scenarios with isolated fixture state and unused ports for parallel execution. Reuse generated grids for related read-only checks while keeping mutation scenarios isolated.
4. Prefer end-to-end tests with real servers interacting through their actual interfaces. Launch production entrypoints where possible, and keep orchestration responsible for configuration, readiness, external fault controls, observation, and teardown. Share resource setup through a small fixture while keeping scenarios and assertions explicit. Test servers must use the real frontend-serving implementation so routing and cache behavior are exercised.
5. Verify the GitHub OAuth integration through its real flow. Use controlled inference streams for deterministic scheduling, failure, billing, and ordering scenarios while retaining the real provider adapter/parser, database, files, engine, web process, internal API, and browser.
6. Keep mocked scope as thin as possible, ideally absent. Prefer actual SQLite locks, transaction failures, network interruptions, and process signals over replacing application methods or changing cancellation behavior. When deterministic provider responses are needed, control the external HTTP service while retaining the real application, SDK, transport, and persistence code. Use explicit synchronization points, and keep crash controls confined to test processes. Pure policy tests should call the actual functions directly.

### Running the suites

Select tests that cover the features changed. Simple wording, styling, and documentation changes do not require tests. Run manual tests only on staging through SSH. GitHub CI runs the default full suite on pushes to `master`; the complete unit, mock browser, and real-provider browser suites must also pass on staging before production deployment.

```sh
pnpm test
pnpm test:built
pnpm test:unit
pnpm test:e2e:mock
pnpm test:e2e:real
```

`pnpm test` builds once, then runs unit tests and the mock and real Playwright projects against that build. Unit tests that start web or browser fixtures require `dist/index.html`, so run `pnpm build` before invoking `pnpm test:unit` on a clean checkout. `pnpm test:built` runs the same suites against the existing build, without rebuilding it. The E2E runner also accepts `--reuse-build` for focused runs against an existing build. The separate E2E commands build once and run their respective project. Verify test-runner changes from a clean checkout without retained frontend assets.

### Creation and persistence recovery coverage

List-title coverage checks persisted axis expansion, repeated variables, literal
dollar signs in values, Unicode-safe truncation, and preservation across title
edits, generation updates, and reopening storage. Older-grid coverage verifies
that the original prompt is copied into a missing field once. The title browser
journey checks custom title precedence and truncated expanded prompts in owned
and public lists after clearing the title and reloading.

Creation recovery tests use concurrent HTTP submissions, an unavailable engine,
web replacement and a failed receipt transaction to verify one saved grid,
ownership checks and explicit Resume after an uncertain start. Browser coverage
drops a successful creation response, reloads the draft and verifies that the
same request ID recovers the existing grid.

Runtime fault tests use real SQLite writer locks and a deferred foreign-key
constraint to cover admission rollback, dispatch waiting for persistence,
immediate HTTP cancellation and completion retained through a failed save.
They verify retained output, thinking and exactly one charge per call after
recovery. Inspector checkpoints place locks or kill the engine at specific
persistence boundaries without changing its methods. Crash coverage retains the
distinction between installed files and committed completion; a restart never
replays inference automatically.
Disk-full recovery is outside this validation scope. Run these checks on staging
with the affected billing, publication, migration, reuse and live-update tests.

### GitHub CI

The CI workflow runs `pnpm test` on every push to `master`, covering unit tests, the frontend build, mock browser tests, and real OpenRouter browser tests. It uses the `test` environment and its `OPENROUTER_API_KEY` secret. Missing credentials or provider failures fail the run. GitHub client values are non-secret test placeholders because these suites do not authenticate with GitHub; the separate GitHub login suite remains an explicit integration check.

Mock E2E tests are grouped into setup, display, access, and generation files and run with three workers. Each test has its own app, upstream fixture, unused ports, temporary SQLite database, outputs, and child process; state-changing tests remain sequential within each file. Test-scoped app instances keep production rate limits enabled while preventing earlier tests from consuming later tests' allowances. Shared helpers keep setup consistent, and interaction journeys reuse grids across state transitions and reloads within a test. Real-provider and GitHub suites run serially in one isolated app server each. Fixture cleanup waits for the app and its inference process to exit before removing temporary app data; test artifacts are removed after each test or suite finishes.

Rate-limit browser coverage exhausts the real grid-creation and API request allowances, checks the visible server message and enabled Generate control after repeated rejection, preserves the draft across reload, and verifies that retry creates exactly one grid once a fresh client address has allowance.

Provider endpoint tests exercise rejection of missing provider attribution or pricing, acceptance of explicitly empty pricing, recovery after corrected metadata, and reuse of a successful cached response. Image-pricing browser coverage checks provider rates, units, tiers, missing prices, and selection/compatibility behavior through axis swaps. Image compatibility tests isolate simultaneous failures by parameter, preserve unknown metadata, and identify provider-combination and pixel-size/aspect-ratio conflicts without warning on unrelated settings. Browser coverage checks model-by-value matrices for both axis and shared parameters, reference-group counts, specific tooltips, disappearance after correcting settings, and stable orientation through axis swaps. Image-dimension browser coverage follows custom sizes and advisory compatibility through axis swaps, captures the actual SDK request parameters, and checks that reference groups stay local until Generate. It verifies previews across reload, Edit, and Fork, exact reference bytes per inference, and reuse without duplicate uploads. Removing the last file preserves the group through reload; submission rejects the empty group before uploading, and adding files again restores generation. A database write fault verifies that failed uploads stop submission, report an upload error without format advice, and remain retryable with the selected files. Reference-route tests cover unauthorized attachment, private reads, cross-origin writes, file-type rejection, filesystem/database failures and recovery, account claims, selected publication, fork ownership, and reopened storage. Shared image-field coverage exercises transfers into axes, resets when leaving axes, swaps, Custom selection with separate Width and Height fields, multiple custom axis pairs, removal, incomplete-pair rejection, clearing to Auto, and persistence through reload, Edit, and Fork. Default and explicit Auto settings must produce the same prepared request, compatibility result, and artifact signature, with omitted parameters verified in captured inference requests. Shared-reference scenarios verify deferred uploads, retry after storage failure, ordered bytes, axis transfers, publication, and reuse without additional uploads. Reference ownership and fork-access tests run for both axis groups and shared collections.

The mock project exercises the real app and AI SDK against a local HTTP OpenRouter fixture. It covers OAuth with PKCE, manual connection and invalid-key replacement, image rendering, controlled billing and provider failures, retries, publishing, ownership, isolated hosting, streaming stages, fair scheduling, and HTTP cancellation. It never contacts OpenRouter or spends credits.

The real project uses OpenRouter directly for one-cell Markdown, SVG, and static website generations, including rendering and reload. These success scenarios replace their mocked equivalents. It selects `nvidia/nemotron-3-super-120b-a12b:free`, disables thinking, and uses a $0.001 cell budget. There is no paid-model fallback, retry of failed tests, or silent skip when credentials or the model are unavailable. The website request specifies exact HTML, CSS, and JavaScript contents so this integration check tests transport, storage, and browser execution without depending on the model's design choices. Real-test traces, screenshots, and videos are disabled.

Provide `OPENROUTER_API_KEY` to the test process, or create `slopgrid/test.config.json` under your user configuration directory (`XDG_CONFIG_HOME`, otherwise `~/.config`) with `keySource` pointing to an existing environment file and optional `keyVariable` (default `OPENROUTER_API_KEY`). The configuration contains a reference rather than a copied credential. The runner supplies the resolved key only to Playwright; the browser connects through the normal manual-key form. Keep credentials and this private configuration outside the repository.

Mouse-drag browser scenarios cover two-axis panning from image padding and cell footers, exclusion of image/Markdown/website content and controls, pointer release, and coexistence with column resizing. Touch gestures retain checks that zooming and scrolling respond to interaction, and keyboard resizing is checked through saved dimensions and restored handle values. Controlled error responses, exact billing amounts, timing gates, and scheduling scenarios remain mocked because their outcomes must be reproducible.

Streaming usage coverage checks token growth during thinking and output, stable input counts, replacement by reported usage, reconnect snapshots, and reset after failure or retry. Scheduler coverage checks that paused or superseded calls cannot restore discarded token and cost estimates.

Provider budget coverage exercises unknown pricing and token limits through the
real adapter and controlled HTTP responses, checking successful generation,
omitted output token limits and price caps, and absent unknown cost estimates.
Include Auto Router metadata with a catalog context size and no completion limit
to verify that routing can use the selected model's output allowance.
Artifact reuse coverage includes generation and copying with missing pricing.

Streaming persistence coverage measures SQLite changes across chunk bursts and
throttled notifications, checks that a trace identifier is checkpointed once,
and records updated cell rows to ensure completion and dispatch leave unrelated
cells untouched. Ordering coverage includes drafts within one engine epoch,
concurrent metadata edits, and recovery of paused grids with interrupted calls.
The browser delays a real HTTP response while newer drafts arrive and verifies
that the delayed response cannot replace the newer output or thinking.

Scheduler lifecycle coverage also resumes a grid before its cancelled call has
settled. The old call must retain its worker slot, its late billing failure must
not pause the resumed grid, and its late chunks must not overwrite the replacement
attempt. The replacement clears the prior attempt's thinking identifier only when
it dispatches.

Pause settlement browser coverage keeps two cancelled calls outstanding, reloads
the paused grid, replaces the web process while a call settles, and checks that
reconnection recovers its charge before the stream closes after the final call.
A fixture-only adapter
wrapper withholds the AbortSignal from the real provider, allowing the controlled
upstream to finish after cancellation while retaining the SDK, parser, billing,
engine, web process, and browser. Late output remains discarded. Engine coverage
checks that the stable snapshot has a newer ordering token than the paused live snapshot.

Recovery coverage kills the engine after manual Pause, both while billing is
running and after the charge is recorded but before the scheduler releases the
call. The recovered snapshot must have a newer engine epoch and reject the
delayed pre-crash snapshot through the browser cache. Preserve recorded charges,
partial thinking, pending cells, and the manual pause reason without starting
replacement calls. A second restart must advance the epoch while preserving
settled state. Multi-call pause coverage checks that live updates continue until
the last call settles; streaming coverage still requires zero SQLite writes for
draft bursts. Snapshot-read coverage checks strictly increasing sequences without
database writes, fresh ordering after settled metadata edits, and a stable epoch
across web replacement. Browser coverage delays a paused HTTP snapshot across an
engine restart and checks that its later arrival cannot reopen streaming.
Migration coverage preserves existing grid metadata, sessions, cells, references,
and charges, and checks that reopening storage does not reset the engine clock.

The runtime behavior tests share `tests/runtime-fixture.ts`: a controlled OpenRouter HTTP service, a real inference child, a replaceable web child, and a temporary SQLite database and output directory. The actual provider SDK, stream parser, billing recorder, and Unix-socket API remain in use. Fixture children, including browser app processes, report readiness over IPC after their listeners are available. Startup waits report the child error or exit status, with a bounded timeout for a hung process, instead of treating a delayed startup as an application transition failure. Tests explicitly release streaming chunks or failures instead of relying on provider response timing. Sessions are seeded directly; authentication flows have separate coverage.

Grid-price coverage distinguishes visible successful-output cost from owner-only lifetime spending. Billing tests cover reported usage arriving before cell settlement, reported zero charges, cancellation, retries, and isolation between grids. Browser coverage follows both totals through streaming, failure, retry, reload, and publication; HTTP and SSE coverage ensures non-owners never receive `spentUsd`. Reordered-snapshot coverage checks both displayed totals. A controlled-stream browser scenario checks thinking scroll-following through successive chunks and viewport resizing, wheel-scrolling up to preserve a reading position, returning to the bottom, and completion through the saved-trace fetch. Thinking-exhaustion coverage distinguishes a fully consumed reasoning budget from partial output and early termination, verifies durable errors and traces, separates charges from successful-output costs, and observes SSE closure. SVG view-switch coverage checks decoded image content while hidden behind thinking, preserves the mounted preview across toggles, and verifies completion while thinking remains selected. Expansion coverage follows SVG updates through completion and website updates in the overlay, verifies generated JavaScript execution, and checks image/SVG/website collapse via Escape, restored focus, retained table elements, and saved dimensions. Website coverage presses Escape while focus is inside the isolated frame.

### Required runtime coverage

Thinking compatibility browser coverage checks model rows and effort columns across axis swaps and fixed selections, without duplicating entries for prompt variables. Assertions verify selected header order and model/value/status accessible names while generation and resume remain advisory.

Model-alias coverage checks published target resolution, catalog aliases without targets, unknown aliases, and cycles. Moving aliases retain their IDs through inference, retry, Edit, publication, and Fork. Selector rendering checks warning presence only for selected moving aliases and verifies interpolated catalog identifiers in both fixed and multiple selection modes without asserting static warning copy.

Model-order browser coverage checks insertion against the unfiltered catalog after manual reordering, tie resolution, mouse and touch dragging, keyboard movement, removal, reload persistence, and axis swaps. Assertions inspect the computed selection order rather than static interface copy. Selection checks isolate model names from pricing, and compatibility expectations follow the selected catalog order. The Edit/Fork journey exercises grid actions in a narrow non-touch viewport so desktop navigation cannot block their pointer targets.

Image-budget regressions check zero, negative, and cleared text budgets through format changes, draft reload, image inference, and Edit. Shared input validation accepts image grids with missing or invalid unused budgets while preserving valid values and rejecting invalid budgets for every text format.

Theme-transition browser coverage checks both polygon reveal directions through the navbar toggle and Settings, saved preferences after reload, animation with either motion preference, and the fallback without the View Transitions API.

Navigation browser coverage combines touch-primary and mouse-primary contexts with narrow and wide viewports, checking menu selection, route navigation, Escape, outside presses, and focus restoration. Mouse-primary checks require the hamburger button to be absent from the DOM, including when Chromium reports secondary touch support. Firefox desktop coverage runs with fingerprinting resistance both enabled and disabled, including navigation and reload, to catch spoofed touch-point counts selecting the hamburger menu on mouse-only devices.

Text-model pricing browser coverage checks per-million conversion, request charges, zero and missing prices, keyboard and hover tooltips, and consistent pricing through axis swaps and fixed-model selection. Image pricing coverage also runs when the shared price display changes.

`tests/e2e/scroll-restoration.spec.ts` covers creation drafts for SVG and Image through refresh, Back, and Forward, checking saved input values and actual scroll offsets while new route visits start at the top.

1. **Web replacement during generation:** keep a real browser open while Markdown, thinking, and website assets stream; replace the web process and verify reconnection, continued previews, correct final content and prices, and no extra provider calls. See `tests/e2e/runtime.spec.ts`.
2. **Lost acknowledgements and competing starts:** lose the response after the engine accepts Start, retry through a replacement web process, and race multiple starts; each cell must run only once. See `tests/generation-commands.test.ts`.
3. **Concurrent writes:** interleave title edits, ownership claims, generation completion, publication, and retries across processes; preserve both metadata and generation changes and prevent publication while work is active. See `tests/generation-metadata.test.ts`.
4. **Complete draining:** cover queued cells, retry timers, and cancelled calls whose provider work has not settled. Accepted work finishes, new work is rejected, drained status waits correctly, and cancelling maintenance restores admission. See `tests/generation-drain.test.ts`.
5. **Engine death at persistence boundaries:** kill the real process midstream and around billing, file, and cell-state persistence. Preserve committed outputs, retain recorded charges, settle interrupted ledger entries, and require explicit Resume without duplicating completed work. See `tests/generation-crash.test.ts`.
6. **Reordered browser updates:** release older HTTP or SSE snapshots after newer state, including across reconnection, and ensure output, thinking, title, status, and prices never regress even transiently. See `tests/e2e/ordering.spec.ts`.
7. **Slow and disconnected viewers:** stall one subscriber while another remains healthy, repeatedly disconnect/reconnect, and verify generation continues, abandoned capacity is released, and a reconnect sees current state. See `tests/generation-viewers.test.ts`.

Crash tests use `tests/crash-checkpoint.ts` to attach Node's inspector to the fixture engine and stop at a specific statement before killing the process. Checkpoints are located in the executed script and must identify a unique statement. Inspector activation exists only in the test supervision wrapper. Cancellation and drain tests observe the real SDK closing the upstream HTTP connection, while a SQLite writer lock keeps settlement pending. Browser tests retain the same pending state across reload, web replacement and engine death, and verify that late writes from the external provider cannot install cancelled output.

The shared browser and runtime fixtures run the production web and engine entrypoints with their real frontend router, SDK, private API, database and file storage. Deterministic scenarios control an external HTTP provider; the real-provider suite connects to OpenRouter. The paused-settlement browser test waits for a real HTTP 502 from the proxy while the web process is stopped, then verifies automatic stream recovery after replacement. Isolated scheduler policy tests still use a controlled provider and clock, and identity unit tests control external OAuth responses.

## Runtime configuration

`pnpm build` checks TypeScript and creates the frontend build. `pnpm start` serves that build in production mode and connects to the separately managed inference process started with `pnpm start:engine`. The production process requires `APP_ORIGIN`, `OUTPUT_DOMAIN`, and `KEY_ENCRYPTION_SECRET` to be provided in its environment.

| Variable                | Behavior                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`            | Application origin, including scheme and optional port; HTTPS is required in production.                                                                          |
| `OUTPUT_DOMAIN`         | HTML output host suffix beginning with a hyphen, with an optional port; joins the cell ID in one DNS label. Images, Markdown, and SVG use the application origin. |
| `KEY_ENCRYPTION_SECRET` | Exactly 64 hexadecimal characters representing the persistent 32-byte encryption key. Required in production.                                                     |
| `DATABASE_PATH`         | SQLite file path; defaults to `.data/slopgrid.sqlite`. Its parent directory must exist.                                                                           |
| `OUTPUTS_PATH`          | Directory for generated output files; defaults to an `outputs` directory beside the SQLite database.                                                              |
| `PORT`                  | Listening port; defaults to 3000.                                                                                                                                 |
| `BIND_ADDRESS`          | Listening address; defaults to `127.0.0.1`.                                                                                                                       |
| `GENERATION_SOCKET`     | Private Unix socket shared by web and inference processes; defaults to `generation.sock` beside the database.                                                     |
| `GENERATION_DRAINING`   | Set to `1` to start the inference process with admission closed.                                                                                                  |
| `FRONTEND_PATH`         | Frontend build directory served by the web process; defaults to `dist`.                                                                                           |
| `OPENROUTER_BASE_URL`   | Provider API base URL for both processes; defaults to the OpenRouter API.                                                                                         |
| `OPENROUTER_AUTH_URL`   | OpenRouter authorization page URL for the web process; defaults to the OpenRouter authorization page. Browser fixtures point it at their external OAuth service.  |
| `WORKERS_MAX`           | Maximum concurrent cell generations across the inference process; defaults to 100 and must be a positive safe integer.                                            |

Preserve the automatically created development encryption key, since changing it makes existing stored credentials unreadable. Run exactly one inference process per database, and configure both web and inference processes with the same database, output directory, encryption key, and generation socket.

## Storage maintenance and validation

Keep SQLite and output-directory backups, including uploaded references, together with the encryption key needed to read stored credentials. See [state and persistence](ARCHITECTURE.md#state-and-persistence) for storage responsibilities and output lifecycle.

Storage and route tests exercise persistence and reopening. Upgrade and unsupported-version tests check that existing data is preserved. Session tests reopen storage with an old session and verify retained account identity, encrypted credentials, persistent cookie renewal, and logout revocation.

## Generation and output validation

Grid input coverage sends a request exceeding 100 KB through HTTP creation, persistence, and inference, preserving long prompts, variable values, and model IDs. Budget tests cover pricing and context limits, text-token ceilings, saved budgets, and format-specific validation.

Retry tests cover missing and malformed guidance, HTTP and streamed metadata headers, elapsed cooldowns, and explicit Resume. Provider tests cover structured-output capability routing and rejection without downgrade, while browser tests check streamed website content, JavaScript execution, and pause/resume for both schema and prompt-based requests. The real-provider suite uses an explicit free schema-capable model. Output parsing tests preserve arbitrary file extensions and extensionless assets while rejecting traversal.

Output-access integration tests cover all formats, previews, downloads, session revocation, revoked grants, account ownership, and publication. The HTTPS browser regression uses sibling output hosts to verify private stylesheet and module loading, imported assets, direct output navigation before visiting the grid, opening output tabs, reloads, and authorization across session rotation. Account coverage claims an anonymous grid and opens the same direct output URL in two independent sessions of the owning user, revokes one session while the other keeps working, and rejects a different account and an unauthenticated visitor. It also checks that generated documents cannot regain network access by removing the bootstrap's restrictive CSP meta element.

Image/SVG cache coverage checks reuse without transferring bytes across page visits, rejects a private cached response after the session cookie is removed, and permits public cache reuse across cookie changes. Route coverage verifies one-year private cache freshness independently of session age and confirms that conditional requests cannot bypass session revocation.

## Asset licenses

When replacing bundled fonts or icons, retain their distribution notices and verify that the build includes them. The included notices are `public/fonts/DejaVu-LICENSE.txt` and `public/lucide-LICENSE.txt`.

## Publishing validation

Publishing tests cover access, immutable visibility, summary filtering, and persistence. Browser tests cover dialogs and saved preferences, navigation from public discovery on the creation page, and hiding discovery after output-type selection and draft restoration.

## Generation process control

`pnpm generation status` reads the engine instance and workload counts. `pnpm generation drain` closes admission and waits for accepted grids and unsettled requests to finish. `pnpm generation accept` reopens admission, including when cancelling a planned machinery update. These commands require the same runtime configuration as the application and connect only through its private socket. A drain has no inference timeout and does not cancel user work.

Choose the deployment mode using the [process boundaries](ARCHITECTURE.md#process-boundaries). Both mocked and real-provider browser suites use a separate inference child process. The process-lifetime regression replaces the web child during an active streamed call and verifies queue draining and recorded costs.

## Artifact reuse validation

`tests/artifact-reuse.test.ts` uses the runtime fixture's real web and engine processes, SQLite, output files, provider SDK and controlled upstream streams. It extends a partially completed grid through axis changes, failures and cancellation, replaces the web process during streaming, and restarts the engine before reusing copied provenance. It checks bundle and thinking independence, missing nested assets, unreadable files and unsigned historical outputs. Cross-account forks cover private-source rejection, publication, inherited costs, new failed and retried charges, private output access, connection requirements, and creation of fully reused grids without an inference balance check.

Request-matching scenarios observe actual upstream calls for changes to model, substituted prompt, effort and output format. Budget and token-ceiling coverage checks unchanged computed limits, increases, decreases, usage exactly at and above the new limit, reasoning-inclusive usage, selection of a later eligible source, missing usage, and copies across process restarts. Signature coverage prepares a request with the real provider adapter, compares it with persisted generation provenance and captured SDK parameters, then calls the actual signature function with changed instructions, schema, routing and adapter revision. Reordering request object keys preserves the signature. Browser coverage in `tests/e2e/artifact-reuse.spec.ts` follows the checkbox and a lowered budget through Edit, draft reload, OAuth and Fork, verifies immediate copied outputs beside fresh work, and regenerates all cells when reuse is unchecked. Image coverage uses the existing image fixture and captured SDK requests to check reference bytes, order, renamed uploads and image settings.

Reuse preparation coverage combines a valid copy with an unpriced model, checks insufficient budgets with signed and unsigned sources, and verifies that these errors remain per-cell failures without upstream calls.

Controlled provider fixtures must supply a signature for successful results, while unsigned-history scenarios remove provenance from stored cell metadata. Request preparation types enforce the text budget and image/text distinction before execution.

Image reuse matrices vary one value within the same axis kind, compare complete captured SDK requests, and include unchanged-request controls. Each image setting must independently force generation, while changed dollar budgets and unused text thinking settings preserve reuse. The checkbox journey uses fixture charges large enough for Cost and Spent to display distinct totals, while checking their precise API values and token usage.

Storage copy coverage reads and writes real bundles asynchronously, preserves binary artifact and thinking bytes, rejects incomplete source inventories, and checks that copies survive source removal. Runtime reuse coverage also exercises one source serving multiple destination cells.

Reference loader tests use real files to verify byte/hash consistency, ordered duplicates, reuse within one loader after a source file becomes unavailable, and fresh reads for a new loader. Browser reference scenarios continue checking the actual SDK data URLs and copied image bytes.

Reuse scenarios use typed grid snapshots and captured requests, consume new upstream calls sequentially, and name parameter cases with assertions on the effective request. Monetary assertions compare expected dollar amounts with a small floating-point tolerance rather than encoding binary rounding artifacts. The readiness regression starts real inference processes with invalid and valid configuration to check useful startup errors and an immediately usable API.

Browser-fixture lifecycle coverage starts the production entrypoints behind HTTPS, exercises their API, and verifies process cleanup, temporary data removal and reuse of the listening port.

Budget estimation coverage includes mixed calculated and $3 fallback costs, dispatch-order prefixes, zero output prices, exact input-cost budgets, unknown metadata, prompt expansion, pricing schedules, and automatic versus explicit worker selection. Browser coverage verifies automatic form submissions despite stale draft overrides for text and images, per-model warning grouping, highest calculated amounts across expanded prompts, and simultaneous known and unknown estimates without asserting static tooltip wording, plus saved budgets and automatic submission. Admission tests cover unfinished-cell counts on Resume, artifact reuse, and budget-specific 403 pauses while active calls finish.
