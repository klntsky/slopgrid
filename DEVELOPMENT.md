# Development

## Requirements and setup

Use Node.js 22.12 or newer, pnpm 12.4.2, and tmux. SQLite uses `better-sqlite3`; environments without a matching prebuilt binary need Python and a C/C++ build toolchain. Native build permissions are in `pnpm-workspace.yaml`.

```sh
pnpm install
pnpm exec playwright install chromium
pnpm dev
```

Open http://localhost:3000. Chromium resolves `*.user.localhost` to loopback for generated outputs. OpenRouter OAuth supports localhost callbacks. The development server creates a SQLite database and encryption key under `.data/`; preserve both to retain sessions. No manually entered API-key flow exists.

## Validation

```sh
pnpm test
pnpm test:e2e
```

The unit tests cover prompt expansion, input and bundle validation, encrypted key storage, and recovery after restart. Playwright exercises the real app and AI SDK against a local HTTP OpenRouter fixture: OAuth with PKCE, all output modes, billing interruptions and repeated retries, publishing, ownership, isolated hosting, settings, and scrolling headers. The fixture never contacts OpenRouter or spends credits. `test:e2e` builds the app, starts the fixture in a uniquely named window of tmux session `bg`, runs Chromium, and removes its temporary database and window.

Tests are written around user outcomes and consequential boundaries; do not add snapshots of implementation details or assertions that repeat the code. Live OpenRouter generation requires your own account and is not covered by the fixture suite.

## Runtime configuration

`pnpm build` checks TypeScript and creates the frontend build. `pnpm start` serves that build in production mode. The production process requires `APP_ORIGIN`, `OUTPUT_DOMAIN`, and `KEY_ENCRYPTION_SECRET` to be provided in its environment.

| Variable                | Behavior                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`            | Application origin, including scheme and optional port; HTTPS is required in production.                      |
| `OUTPUT_DOMAIN`         | Host suffix for per-cell output URLs, with an optional port; must be separate from the application host.      |
| `KEY_ENCRYPTION_SECRET` | Exactly 64 hexadecimal characters representing the persistent 32-byte encryption key. Required in production. |
| `DATABASE_PATH`         | SQLite file path; defaults to `.data/slopgrid.sqlite`. Its parent directory must exist.                       |
| `PORT`                  | Listening port; defaults to 3000.                                                                             |
| `BIND_ADDRESS`          | Listening address; defaults to `127.0.0.1`.                                                                   |

Development creates a local encryption key automatically. Changing the encryption key makes existing stored credentials unreadable. Run one application process per database: workers and SSE subscribers are process-local.

## Operational limits

Each browser session can create ten grids and retry thirty times per hour; each client IP can create thirty grids per hour. API traffic is limited to 600 requests per client IP per minute, and generated outputs to 2,000 requests per client IP per minute. There are four concurrent grids globally and one per session, with cells processed sequentially within each grid. SSE is limited to five connections per session and 100 globally. These counters are in memory and reset on restart. Each provider request times out after three minutes, and SDK automatic retries are disabled.

Text output is limited to 2 MB per cell. Website bundles must contain `index.html`, at most 40 files, and safe relative paths with html/css/js/json/txt/svg/md extensions. Image outputs are limited to 10 MB per cell. Models are discovered from OpenRouter and cached for five minutes; unsupported reasoning settings can produce a cell error, which is retryable. No automatic data retention or database cleanup runs. Sessions expire 30 days after creation. Treat output URLs as bearer capabilities, including before publication.
