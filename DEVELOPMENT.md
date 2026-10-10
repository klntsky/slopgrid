# Development

## Requirements and setup

Use Node.js 22.12 or newer, pnpm 12.4.2, and tmux. SQLite uses `better-sqlite3`; environments without a matching prebuilt binary need Python and a C/C++ build toolchain. Native build permissions are in `pnpm-workspace.yaml`.

```sh
pnpm install
pnpm exec playwright install chromium
pnpm dev
```

Open http://localhost:3000. Chromium resolves HTML output hosts ending in `.localhost` to loopback. Images, Markdown, and SVG use paths on the application origin. OpenRouter OAuth supports localhost callbacks. The development server creates a SQLite database and encryption key under `.data/`; preserve both to retain sessions. No manually entered API-key flow exists.

## Validation

```sh
pnpm test
pnpm test:e2e
```

The unit tests cover prompt expansion, input and bundle validation, encrypted key storage, fair worker allocation, cancellation and retry, and recovery after restart. Playwright exercises the real app and AI SDK against a local HTTP OpenRouter fixture: OAuth with PKCE, all output modes, billing interruptions and repeated retries, publishing, ownership, isolated hosting, settings, scrolling headers, parallel generation across browser sessions, and pause/resume with real HTTP cancellation. The fixture never contacts OpenRouter or spends credits. `test:e2e` builds the app, starts the fixture in a uniquely named window of tmux session `bg`, runs Chromium, and removes its temporary database and window.

Tests are written around user outcomes and consequential boundaries; do not add snapshots of implementation details or assertions that repeat the code. Live OpenRouter generation requires your own account and is not covered by the fixture suite.

## Runtime configuration

`pnpm build` checks TypeScript and creates the frontend build. `pnpm start` serves that build in production mode. The production process requires `APP_ORIGIN`, `OUTPUT_DOMAIN`, and `KEY_ENCRYPTION_SECRET` to be provided in its environment.

| Variable                | Behavior                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`            | Application origin, including scheme and optional port; HTTPS is required in production.                                                                          |
| `OUTPUT_DOMAIN`         | HTML output host suffix beginning with a hyphen, with an optional port; joins the cell ID in one DNS label. Images, Markdown, and SVG use the application origin. |
| `KEY_ENCRYPTION_SECRET` | Exactly 64 hexadecimal characters representing the persistent 32-byte encryption key. Required in production.                                                     |
| `DATABASE_PATH`         | SQLite file path; defaults to `.data/slopgrid.sqlite`. Its parent directory must exist.                                                                           |
| `OUTPUTS_PATH`          | Directory for generated output files; defaults to an `outputs` directory beside the SQLite database.                                                              |
| `PORT`                  | Listening port; defaults to 3000.                                                                                                                                 |
| `BIND_ADDRESS`          | Listening address; defaults to `127.0.0.1`.                                                                                                                       |
| `WORKERS_MAX`           | Maximum concurrent cell generations across the application process; defaults to 100 and must be a positive safe integer.                                          |

Development creates a local encryption key automatically. Changing the encryption key makes existing stored credentials unreadable. Run one application process per database: workers and SSE subscribers are process-local.

## Storage and migrations

SQLite stores grid configuration, cell state, and encrypted session credentials. Generated output bodies live on disk, with one directory per cell; image files contain binary bytes and website files retain their relative paths. Streaming drafts remain in memory. Changing metadata or publishing a grid never rewrites its completed output files.

Append schema changes to the SQL migration list in `server/migrations.ts`, using a positive integer version greater than every previous version. Do not reorder or edit applied migrations. Startup validates the full sequence, applies only pending versions, and records each version through SQLite’s `user_version` in the same transaction as its SQL. A failed step rolls back its SQL and version, while earlier successful steps remain applied. A database with an unsupported or newer version cannot start. Tests cover migration ordering, reruns, data preservation, and rollback.

The current schema starts with version 1 on an empty database and does not import the previous unversioned schema. SQLite backups and generated file backups must be kept together, along with the encryption key needed to read stored credentials. Temporary output directories can remain after a process crash; an unfinished cell stays retryable, and retry replaces any uncommitted output for that cell. No automatic file cleanup runs.

## Operational limits

Each browser session can create ten grids and retry thirty times per hour; each client IP can create thirty grids per hour. API traffic is limited to 600 requests per client IP per minute, and generated outputs to 2,000 requests per client IP per minute. Grids queue their cells in a shared worker pool, with up to `WORKERS_MAX` concurrent cell generations. Allocation counts all active cells across each browser session’s grids. Each free slot goes to an eligible session with the fewest workers; ties favor the least recently allocated session, with unserved sessions first. All available capacity is used, with no reserved slots or cancellation for rebalancing. Manual pause aborts active requests for that grid and removes its queued work until resume. Billing or authentication failures pause queued work for that session, while its already active calls can finish. A worker slot covers the whole cell, including both sequential calls for draft and review. SSE is limited to five connections per session and 100 globally. These counters are in memory and reset on restart. Each provider request times out after three minutes, and SDK automatic retries are disabled. Streaming drafts remain in memory and are broadcast at most once per 300 ms per grid, with cell transitions persisted and emitted immediately.

Text output is limited to 2 MB per cell. Website bundles must contain `index.html`, at most 40 files, and safe relative paths with html/css/js/json/txt/svg/md extensions. Image outputs are limited to 10 MB per cell. Models and their reasoning capabilities are discovered from OpenRouter and cached for five minutes. The form warns about incompatible output formats, mandatory reasoning disabled through None, unsupported effort levels, and explicit efforts whose router capabilities are unpublished. Model default leaves reasoning settings to the model, and minimal is available alongside the other gateway effort levels. These warnings are advisory: creation, retries, and provider calls send the selected settings without requiring catalog approval. Structural input validation and the requirement to use enabled prompt variables still apply. Provider availability and restrictions that are not published in metadata can still cause retryable generation failures. No automatic data retention or database cleanup runs. Sessions expire 30 days after creation. Treat output URLs as bearer capabilities, including before publication.

## Icons

Interface icons use `lucide-react`, under the [Lucide ISC license](https://lucide.dev/license), with MIT notices for icons derived from Feather. The distributed notices are included in `public/lucide-LICENSE.txt` and copied into the build. The project mark is the custom 5×5 cell SVG in `public/slopgrid.svg`, shared by the wordmark and favicon. The OpenRouter connector uses its official brand asset.
