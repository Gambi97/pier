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
  `CLERK_SECRET_KEY` to the Infisical project keel provisioned. CI injects them into the
  container; the repo holds none.
- **C — App scaffold (Next.js).** Create the app repo (or scaffold into an existing one):
  `<ClerkProvider>` in the root layout, `middleware.ts`, `/sign-in` and `/sign-up` pages,
  an example protected route, `appearance` wired to a theme placeholder, and a gitignored
  `.env.local` for local dev.
- **D — Handoff.** Push the repo to GitHub, print the one-time Google Console checklist
  (only if production Google is wanted), and exit.

The only human input Pier needs beyond keel's inheritance: a Clerk CLI login (once), the
choice of auth methods, and — for production Google only — a Google OAuth client.

## Contract with keel

Pier docks onto what keel already emits: it reads `APP_URL` (the OAuth callback base) and
writes its secrets onto the same additive secret-store convention. keel creates the
`<project>-infrastructure` repo; Pier creates the `<project>` app repo. Dependencies run
one way only: keel → Pier → app.

## Status

Manifesto only. No code yet. Pier gets built on demand, when the first app actually needs
users to log in, not before.

## License

MIT. See [LICENSE](LICENSE).
