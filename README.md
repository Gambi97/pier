# Pier

**The gangway your users board through.** One command scaffolds authentication for a
new project: it configures the identity provider, wires the secrets, and drops the
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
3. **Opinionated where it must be, swappable where it can be.** The provider sits behind
   a standard seam (env vars, OIDC), so vendors stay swappable. The framework adapter is
   an explicit, replaceable choice, not a lock-in.

## Shape

Pier splits in two, and the split is the whole design:

- **Core (framework-agnostic).** Configures the identity provider via its API and pushes
  the auth coordinates to the secret store. Knows nothing about the app framework.
- **Adapter (framework-specific).** Scaffolds the app-side integration: callback route,
  middleware, session handling. This layer is tied to the framework by nature.

Adding a new framework means adding an adapter, never touching the core.

## Decisions

- **Provider: WorkOS** as the general-purpose default. Clean OIDC, works for B2B and B2C,
  fits the env-var + secret-store seam.
- **First adapter: Next.js (TypeScript).** WorkOS's flagship SDK is `authkit-nextjs`, it
  keeps the whole toolchain in one language, and Next produces the container image the
  infrastructure layer already expects.
- **Stack: TypeScript CLI**, distributed via `npx` from GitHub, bootstrapping providers
  through their APIs. Same shape and tooling as keel on purpose: one mental model across
  the fleet.

## Contract with keel

Pier docks onto what keel already emits: it reads `APP_URL` (the OAuth callback base) and
writes its secrets onto the same additive secret-store convention. Dependencies run one
way only: keel → Pier → app.

## Status

Manifesto only. No code yet. Pier gets built on demand, when the first app actually needs
users to log in, not before.

## License

MIT. See [LICENSE](LICENSE).
