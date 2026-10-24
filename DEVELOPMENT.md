# Development

This guide explains how to set up, run, test, and operate Slopgrid. Product
behavior is defined in [PRODUCT.md](PRODUCT.md), and responsibilities and trust
boundaries are described in [ARCHITECTURE.md](ARCHITECTURE.md).

## Requirements and setup

Use Node.js 22.12 or newer and pnpm 12.4.2. Install OpenSSL for temporary HTTPS
certificates and the Playwright browsers. SQLite uses `better-sqlite3`; systems
without a matching prebuilt binary also need Python and a C/C++ toolchain.

```sh
pnpm install
pnpm exec playwright install chromium firefox
```

Supply nonblank `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` through private
configuration before starting the app. Startup fails if either is missing or
blank. Visitors remain anonymous by default and can always choose GitHub
sign-in. OpenRouter connections remain independent. Load development
credentials and provider settings separately from deployed runtime configuration.

## Running a development worktree

```sh
pnpm dev
```

The launcher starts both web and inference processes and prints the application
origin and private engine socket. Use that origin: its worktree-specific
`dev-<path-hash>.localhost` hostname separates browser cookies, and its
OS-assigned loopback port avoids collisions. HMR shares the web listener.
Set `PORT` only when a registered OAuth callback requires a fixed origin, using
an available port for each concurrent worktree.

Keep the worktree's `.data/` database, outputs, and development encryption key
together. Only one development launcher may run in a worktree. Stopping it
stops its processes and removes temporary runtime resources; shutdown may wait
for active provider calls to settle.

Browser storage and service workers belong to an origin, so changing the port
changes that storage origin. Cookies use the hostname rather than the port.
Use separate browser contexts or profiles to compare independent sessions.

## Builds and local tests

```sh
pnpm build
E2E_PORT=0 pnpm test:built
```

`pnpm build` checks TypeScript and builds the production frontend.
`pnpm test` builds first and then runs unit, mock-browser, and real-provider
browser suites. `pnpm test:built` uses the existing build. Unit tests that start
web fixtures also need `dist/index.html`.

For focused runs, select the relevant files:

```sh
pnpm exec tsx --test tests/grid-title.test.ts
E2E_PORT=0 pnpm exec tsx tests/run-e2e.ts --suite mock --reuse-build tests/e2e/grid-slugs.spec.ts
```

The browser runner accepts `mock`, `real`, `github`, or `all` as its suite.
`all` runs mock and real-provider suites. Without `--reuse-build`, it builds
first. Set `E2E_PORT=0` to allocate a port; missing, invalid, or occupied fixed
ports fail. Fixtures own temporary data, sockets, listeners, and child processes,
and clean them up when finished. Manually configured candidate runtimes should
set `FRONTEND_PATH` to that candidate's `dist` directory.

Mock suites use a local provider fixture. Real-provider suites contact
OpenRouter and use its credits. Supply `OPENROUTER_API_KEY`, or create
`slopgrid/test.config.json` under `XDG_CONFIG_HOME` (otherwise `~/.config`)
with `keySource` pointing to an existing private environment file and optional
`keyVariable` naming its key variable. Keep credentials and browser session
files outside tracked source. GitHub credential placeholders suffice for mock
and real-provider suites, while the GitHub suite needs registered credentials.

Direct browser runs make one attempt by default. Deployment validation permits
two retries for real-provider browser tests. Unit and mock tests do not retry.
GitHub Actions is disabled; its workflow file is retained.

## GitHub integration

Copying staging credentials to a demo does not change the OAuth app's registered
callback URL. Keep staging's OAuth registration unchanged.

Register the test origin followed by `/api/auth/github/callback` with GitHub.
Use an available fixed `E2E_PORT` if the registered callback requires one.
Supply real GitHub credentials and the real-provider test key, then run
`pnpm test:e2e:github`. Set `GITHUB_INTERACTIVE=1` for visible login, or set
`GITHUB_BROWSER_STATE` to a private authenticated Playwright storage-state file.

To create that file, run the following in a private directory outside the
repository, sign in, and close the browser:

```sh
umask 077
npx playwright install chromium
npx playwright codegen https://github.com/login --save-storage=github-state.json
```

Recreate the file when the session expires, and keep it private because it
contains authentication cookies.

## Engine control and deployment

`pnpm generation status`, `pnpm generation drain`, and `pnpm generation accept`
address the configured private engine socket. For a development worktree, set
`GENERATION_SOCKET` to the socket printed by its launcher. Drain closes admission
and waits for accepted work; accept restores admission.

Use `./ops/deploy.sh validate [REV]` for committed local candidate validation.
The default revision is HEAD in the invoking application worktree. Select files
with repeated `--unit FILE` and `--browser FILE` arguments. Builds and suites run
locally with isolated data; validation does not deploy a runtime.

The ignored application-root `.env` supplies deployment settings. Staging and
production are explicit targets, and production accepts only the authoritative
remote master tip. The pipeline uploads the locally validated frontend,
rehearses production migrations remotely, and reports the final deployment
status. Use `./ops/deploy.sh demo [REV]` for a Tailscale-served candidate under
your current local account. For configuration, demo prerequisites, deployment
modes, recovery, and data administration, see
[operations development](ops/DEVELOPMENT.md).
