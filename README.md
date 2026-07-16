# Pier

**The gangway your users board through.** One command scaffolds authentication for a
new project: it creates the identity application, wires the secrets, and drops the
app-side integration in place. Pier runs **once**, hands you a repository you fully
own, and never stays in the loop.

Pier is the boarding point in a small fleet: [keel](https://github.com/Gambi97/keel-cli)
lays the infrastructure spine, Pier is the pier people walk up to get on board, the app
is the ship. Two reusable run-once bootstrappers, one bespoke app on top.

## Opinions

Three opinions drive every decision; a change that violates one is wrong even if useful.

1. **Run once, then leave.** Pier is a bootstrapper, not a control plane. It configures
   things, hands you a repo you own, and exits. It never becomes a runtime dependency.
2. **The app owns zero auth secrets in source.** Provider credentials land in the secret
   store; the app reads coordinates from env vars. The repository holds none of them.
3. **Buy the generic, don't build it.** Authentication is a generic subdomain, not the
   core domain of any app it serves. Pier uses a managed provider behind a swappable seam
   (env vars / OIDC) rather than self-hosting an auth stack you'd then have to own.

## Shape

Pier splits in two, and the split is the whole design:

- **Core (framework-agnostic).** Creates and configures the identity application via its
  CLI/API and pushes the auth coordinates to the secret store. Knows nothing about the
  app framework.
- **Adapter (framework-specific).** Scaffolds the app-side integration: provider,
  middleware, sign-in / sign-up pages, protected routes. This layer is tied to the
  framework by nature.

Adding a new framework means adding an adapter, never touching the core.

## Decisions

- **Provider: Clerk.** Chosen after a verified provider comparison against four filters:
  generous free tier, API/CLI automatability, managed-behind-a-seam, first-class Next.js
  SDK. Clerk wins on automatability — its CLI (`clerk apps create`, `clerk config patch`,
  `clerk env pull`) scripts the entire setup, including enabling auth methods and setting
  production Google credentials, with no dashboard clicking. It also ships the best
  Next.js App Router SDK and a 50k-MRU free tier.
- **First adapter: Next.js (TypeScript).** App Router, middleware-based route protection,
  Clerk's prebuilt components themed via the `appearance` API. Next produces the container
  image the infrastructure layer already expects.
- **App repo shape: DDD-ready.** The repo Phase C scaffolds is laid out along DDD lines:
  `src/domain` and `src/application` stay framework- and provider-free; Clerk touches only
  the edges — `src/infrastructure/auth` (the provider adapter behind the env-var seam) and
  the Next.js interface layer (`src/app/`, `src/proxy.ts`, the sign-in / sign-up pages).
  Auth is a generic subdomain (opinion 3), so nothing provider-specific may leak into the
  domain model: swapping Clerk for WorkOS must not touch `src/domain` or `src/application`.
- **Auth methods (v1): Google, email + password, magic link, email OTP.** All on Clerk's
  free tier. In Clerk's **development** instance, Google works immediately with Clerk's
  shared credentials (no Google Cloud Console). A **production** instance needs your own
  Google OAuth client (a one-time Google Console step Google requires of everyone, not a
  Pier or provider limitation) — mapped to the non-prod / prod split keel already has.
- **Stack: TypeScript CLI**, distributed via `npx` from GitHub, driving Clerk through its
  CLI. Same shape and tooling as keel on purpose: one mental model across the fleet.
- **Alternative on file: WorkOS AuthKit**, whose 1M-MAU free tier beats Clerk's 50k. The
  switch trigger is scale — reach for WorkOS if apps are expected to blow past 50k users;
  otherwise Clerk's automatability wins.

## How it works

Pier runs after keel (it inherits `APP_URL` and the Infisical coordinates keel emits) and
targets the **app** repo, not keel's infrastructure repo.

- **A — Clerk (via the `clerk` CLI).** `clerk apps create` creates the application;
  `clerk config patch` enables the chosen methods, sets the redirect / allowed URLs from
  keel's `APP_URL`, and injects production Google credentials if provided; keys are pulled
  with `clerk env pull`.
- **B — Secrets (Infisical).** Push `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and
  `CLERK_SECRET_KEY` into the **same Infisical project keel provisioned** — resolved by
  `INFISICAL_PROJECT_ID` or by exact name, authenticated with keel's own machine identity
  (`INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET`, `INFISICAL_HOST` optional). Dev
  instance keys go to every non-production environment; `prod` gets keel-style
  placeholders (the production Clerk instance needs its own Google client first). The
  push is additive like keel's: an existing secret is never overwritten, so re-runs
  cannot clobber a rotated key. CI injects them into the container; the repo holds none.
  Pier never creates the project — keel owns it; missing project means "run keel first".
- **C — App scaffold (Next.js).** Create the app repo in a new (or empty) directory:
  `<ClerkProvider>` in the root layout, `src/proxy.ts` (Next 16's middleware) protecting
  `/dashboard`, `/sign-in` and `/sign-up` pages, an example protected route reading the
  user through the app-owned seam, `appearance` wired to a theme placeholder, and a
  gitignored `.env.local` filled by `clerk env pull`. The repo is git-initialized with a
  first commit. Pier itself is not a dependency of the result.
- **D — Handoff (GitHub).** Create the private app repo and push (`gh`), then wire its
  image-push CI: the `SCW_SECRET_KEY` secret (from the same shell keel ran in) plus the
  `SCW_REGION` / `PROJECT_NAME` / `KEEL_NON_PROD_ENVIRONMENTS` variables. The generated
  CI builds **one portable image** (dummy publishable key at build; real `CLERK_*` keys
  are injected at runtime by keel from Infisical), listening on 8080 (keel's
  `container_port` default): merge to main pushes it to every non-prod environment
  registry, a `vX.Y.Z` tag pushes to prod's — deploying stays a reviewable
  `container_image` change in the infrastructure repo, keel's own contract.

The only human input Pier needs beyond keel's inheritance: a Clerk CLI login (once), the
choice of auth methods, and — for production Google only — a Google OAuth client.

## Contract with keel

Pier docks onto what keel already emits: it reads `APP_URL` (the OAuth callback base) and
writes its secrets onto the same additive secret-store convention. keel creates the
`<project>-infrastructure` repo; Pier creates the `<project>` app repo. Dependencies run
one way only: keel → Pier → app.

## CI & releases

Same fleet convention keel set: branches open PRs, CI gates the merge to main, and
production is a version tag.

- **CI** (`ci.yml`) runs on every PR and push to main: build, lint, format, tests on
  Node 22 + 24, a `--dry-run` CLI smoke, and a **scaffold job** that generates a demo
  app and runs its real `next build` with a well-formed dummy publishable key. A weekly
  cron re-runs it as a canary against the latest in-range Next/Clerk. The pipeline is
  deliberately secret-free — the fleet's real keys live in Infisical only.
- **Release** (`release.yml`): pushing a `vX.Y.Z` tag re-runs the full CI, checks the
  tag against `package.json`, and cuts a GitHub Release, so `npx github:Gambi97/pier#vX.Y.Z`
  pins a production version. npm publish (with provenance) activates only if an
  `NPM_TOKEN` secret is ever configured.
- **Dependabot** keeps npm dependencies (minor+patch grouped, weekly) and the pinned
  GitHub Actions fresh.

## Status

All four phases work — after keel, one pier run hands you a deployable app:
`npx github:Gambi97/pier --name <project> --methods google,password,magic-link,email-otp`
creates the Clerk application, enables the chosen methods (and points Clerk's `paths` at
the scaffold routes), pushes the keys to keel's Infisical project (when the `INFISICAL_*`
coordinates are exported; skipped loudly otherwise), registers the deployed `APP_URL`s as
allowed origins on the dev instance, scaffolds the containerized DDD Next.js repo
(`--dir` to choose where; the target must be new or empty), pulls the dev keys into its
gitignored `.env.local`, git-inits it, and publishes it to GitHub with its image-push CI
configured (`--skip-github` to stop before that).

Re-runs are idempotent end to end: the Clerk app is reused by name, an existing pier
scaffold is recognized and left untouched, the Infisical push never overwrites, and the
allowed origins converge — so "run pier again after keel's first apply" is the designed
way to pick up the freshly synced `APP_URL`s.

Phases A and C are verified end-to-end against a real Clerk account (including a real
`next build` of the generated repo and a standalone-server run proving the runtime key
injection); Phase B's driver mirrors keel's (same endpoints, same payloads) and Phase D
shells out to `gh`, both pinned by tests.

Phase A's config shape is pinned against the live schema (`platform-config/2025-01-01`):
Google is a connection toggle, password is its own `auth_password` key, and magic link /
email OTP are _strategies_ in the `auth_email.sign_in_strategies` array. Pier still
re-validates keys against the live schema on every run and drops unknown ones loudly.
Re-runs are idempotent: an existing application carrying the fleet name is reused, never
duplicated.

Phase C is pinned against the live stack (Next 16.2, `@clerk/nextjs` 7.x — `proxy.ts`,
async `auth()`, `<Show>` instead of `SignedIn/SignedOut`) and verified by `next build` on
a freshly generated repo with real pulled keys. The DDD seam is enforced by tests:
nothing under `src/domain` or `src/application` mentions the provider, provider imports
live only in `src/infrastructure` and the interface layer, and `.env*` never reaches a
commit.

Credentials, either one (instance secret keys `sk_...` are never enough — creating apps
and changing auth config live on Clerk's account-plane Platform API):

- `CLERK_PLATFORM_API_KEY` (`ak_...`) — fully headless, right for CI.
- `npx clerk auth login` once — Pier then rides the stored OAuth token.

What deliberately stays manual: the production Clerk instance (your own Google OAuth
client + DNS, then replace the `prod` placeholders in Infisical) and the deploy itself
(setting `container_image` in the keel tfvars — a reviewable PR, by design).

## License

MIT. See [LICENSE](LICENSE).
