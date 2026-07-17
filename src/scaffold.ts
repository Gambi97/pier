import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ConfigError } from './config.js';

/**
 * Phase C — the Next.js adapter. Plans and writes the app repo Pier hands
 * over: a DDD-layered Next.js (App Router) project with Clerk confined to
 * the edges.
 *
 * The seam, enforced by tests: nothing under `src/domain` or
 * `src/application` mentions the provider. Clerk appears only in
 * `src/infrastructure/auth` (the adapter) and the interface layer
 * (`src/app`, `src/proxy.ts`). Pier itself is NOT a dependency of the
 * generated repo — it runs once and leaves (opinion 1).
 *
 * Versions pinned live on 2026-07-16: next 16.2.x (middleware file is
 * `proxy.ts` since Next 16), @clerk/nextjs 7.x (auth() is async,
 * ClerkProvider goes inside <body>), react 19.2.x, Node >= 20.9.
 */

export function planScaffold(projectName: string): Record<string, string> {
  return {
    'package.json': packageJson(projectName),
    'tsconfig.json': TSCONFIG,
    'next.config.ts': NEXT_CONFIG,
    Dockerfile: DOCKERFILE,
    '.dockerignore': DOCKERIGNORE,
    '.github/workflows/ci.yml': APP_CI,
    '.gitignore': GITIGNORE,
    '.env.example': ENV_EXAMPLE,
    '.env.local': ENV_LOCAL,
    'README.md': readme(projectName),
    'src/proxy.ts': PROXY,
    'src/domain/README.md': DOMAIN_README,
    'src/application/README.md': APPLICATION_README,
    'src/application/ports/authenticated-user.ts': AUTHENTICATED_USER_PORT,
    'src/application/ports/current-user-provider.ts': CURRENT_USER_PORT,
    'src/infrastructure/README.md': INFRASTRUCTURE_README,
    'src/infrastructure/auth/clerk-current-user.ts': CLERK_ADAPTER,
    'src/composition.ts': COMPOSITION_ROOT,
    'src/app/layout.tsx': layout(projectName),
    'src/app/theme.ts': THEME,
    'src/app/globals.css': GLOBALS_CSS,
    'src/app/page.tsx': homePage(projectName),
    'src/app/sign-in/[[...sign-in]]/page.tsx': SIGN_IN_PAGE,
    'src/app/sign-up/[[...sign-up]]/page.tsx': SIGN_UP_PAGE,
    'src/app/dashboard/page.tsx': DASHBOARD_PAGE,
  };
}

/**
 * The target must be brand new or an empty directory — Pier never writes
 * into a repo it did not create. Checked before the Clerk app is touched,
 * so a dirty target fails the run before any remote mutation.
 */
export async function ensureEmptyTarget(dir: string): Promise<void> {
  const info = await stat(dir).catch(() => undefined);
  if (!info) return;
  if (!info.isDirectory()) {
    throw new ConfigError(`Target "${dir}" exists and is not a directory.`);
  }
  if ((await readdir(dir)).length > 0) {
    throw new ConfigError(
      `Target directory "${dir}" is not empty. Pier only scaffolds into a new or empty ` +
        'directory — pick another with --dir.',
    );
  }
}

/**
 * True when the target already holds this project's pier scaffold — the
 * signature is the package name plus the proxy file. Makes re-runs fully
 * idempotent: pier skips the write and continues with the phases that are
 * additive by design (env pull merges, Infisical never overwrites, allowed
 * origins converge), which is exactly what "run pier again after keel's
 * first apply" needs.
 */
export async function detectExistingScaffold(dir: string, projectName: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      name?: string;
    };
    await stat(join(dir, 'src/proxy.ts'));
    return pkg.name === projectName;
  } catch {
    return false;
  }
}

export async function writeScaffold(dir: string, files: Record<string, string>): Promise<void> {
  await ensureEmptyTarget(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(dir, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, 'utf8');
  }
}

/**
 * Best-effort `git init` + first commit; returns false instead of throwing
 * (no git, no identity configured, ...) — the scaffold is complete either
 * way and the caller just tells the user to commit by hand.
 */
export async function initGitRepo(dir: string): Promise<boolean> {
  const git = (args: string[]) =>
    new Promise<boolean>((resolve) => {
      const child = spawn('git', args, { cwd: dir, stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  return (
    (await git(['init', '-b', 'main'])) &&
    (await git(['add', '-A'])) &&
    (await git(['commit', '-m', 'Scaffold auth-ready app (pier)']))
  );
}

function packageJson(projectName: string): string {
  return (
    JSON.stringify(
      {
        name: projectName,
        version: '0.1.0',
        private: true,
        scripts: {
          dev: 'next dev',
          build: 'next build',
          start: 'next start',
          typecheck: 'tsc --noEmit',
        },
        dependencies: {
          '@clerk/nextjs': '^7.5.19',
          next: '^16.2.10',
          react: '^19.2.7',
          'react-dom': '^19.2.7',
        },
        devDependencies: {
          '@types/node': '^24.0.0',
          '@types/react': '^19.0.0',
          '@types/react-dom': '^19.0.0',
          typescript: '^5.6.0',
        },
        engines: {
          node: '>=20.9.0',
        },
      },
      null,
      2,
    ) + '\n'
  );
}

const TSCONFIG =
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2017',
        lib: ['dom', 'dom.iterable', 'esnext'],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        isolatedModules: true,
        // What `next build` (16.2) rewrites this file to — matching it keeps
        // the first build from dirtying the fresh repo.
        jsx: 'react-jsx',
        incremental: true,
        plugins: [{ name: 'next' }],
        paths: { '@/*': ['./src/*'] },
      },
      include: [
        'next-env.d.ts',
        '**/*.ts',
        '**/*.tsx',
        '.next/types/**/*.ts',
        '.next/dev/types/**/*.ts',
      ],
      exclude: ['node_modules'],
    },
    null,
    2,
  ) + '\n';

const NEXT_CONFIG = `import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Self-contained server bundle: the Dockerfile copies .next/standalone and
  // runs server.js directly — no node_modules in the runtime image.
  output: 'standalone',
};

export default nextConfig;
`;

/**
 * One portable image for every environment. The build uses a well-formed
 * dummy publishable key (prerendering needs one that parses); the real keys
 * are injected at runtime — keel reads them from Infisical and sets them as
 * secret env vars on the container, and ClerkProvider picks the publishable
 * key up per-request (see layout.tsx). PORT=8080 matches keel's
 * container_port default, so no tfvars change is needed.
 */
const DOCKERFILE = `# syntax=docker/dockerfile:1

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Well-formed but fake (base64 of clerk.example.com$): next build needs a key
# that parses, never a real one. Real keys arrive at runtime from Infisical.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# keel's container_port default; Next's standalone server honors PORT.
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
USER app
EXPOSE 8080
CMD ["node", "server.js"]
`;

const DOCKERIGNORE = `node_modules
.next
.git
.env*
!.env.example
README.md
`;

const GITIGNORE = `node_modules/
.next/
out/
*.tsbuildinfo
next-env.d.ts

# Secrets live in the secret store, never in this repo.
.env*
!.env.example
`;

const ENV_EXAMPLE = `# Copy of the env contract — real values never land in the repo.
# Local dev: \`npx clerk env pull --app <app id>\` writes them to .env.local (gitignored).
# Deploys: CI injects them from the secret store (Infisical).
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
`;

const ENV_LOCAL = `# Gitignored. Pier pulls the Clerk keys in here; refresh with
# \`npx clerk env pull --app <app id>\`.
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
`;

const PROXY = `import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

// Public-first: everything is public except what is listed here.
const isProtectedRoute = createRouteMatcher(['/dashboard(.*)']);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) await auth.protect();
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
`;

const DOMAIN_README = `# Domain

The core model: entities, value objects, domain services, domain events.

Rules:

- No framework imports. No provider imports. No I/O.
- Depends on nothing outside this folder.
- Authentication is a generic subdomain and never appears here; if a use case
  needs to know who acts, it receives an \`AuthenticatedUser\` from the
  application layer as plain data.
`;

const APPLICATION_README = `# Application

Use cases and ports. Orchestrates the domain; owns the interfaces
(\`ports/\`) that the infrastructure layer implements.

Rules:

- May import from \`domain\` only.
- Ports are defined here (\`ports/current-user-provider.ts\`), implemented in
  \`infrastructure\`, and bound to a concrete adapter only in the composition
  root (\`src/composition.ts\`).
- Nothing provider-specific: \`ports/authenticated-user.ts\` is the only view
  of the signed-in user the inner layers ever see.
`;

const AUTHENTICATED_USER_PORT = `/**
 * The only view of the signed-in user the inner layers may depend on.
 * Provider-agnostic on purpose: the id is an opaque string — never parse
 * it, never assume which identity provider minted it.
 */
export interface AuthenticatedUser {
  id: string;
  email?: string;
  displayName?: string;
}
`;

const CURRENT_USER_PORT = `import type { AuthenticatedUser } from './authenticated-user';

/**
 * Driven port: how this application asks "who is acting?". Defined here,
 * implemented in infrastructure, bound to a concrete adapter in the
 * composition root (src/composition.ts). Nothing outside infrastructure
 * may depend on the implementation.
 */
export interface CurrentUserProvider {
  getCurrentUser(): Promise<AuthenticatedUser | null>;
}
`;

const COMPOSITION_ROOT = `import type { CurrentUserProvider } from '@/application/ports/current-user-provider';
import { clerkCurrentUser } from '@/infrastructure/auth/clerk-current-user';

/**
 * Composition root — the ONLY file where ports meet their concrete
 * adapters. Everything else (pages, use cases) depends on the port types.
 * Swapping the auth provider = write a new adapter + change one line here.
 */
export const currentUserProvider: CurrentUserProvider = clerkCurrentUser;
`;

const INFRASTRUCTURE_README = `# Infrastructure

Adapters: implementations of the application layer's ports against real
providers (auth, persistence, ...).

Rules:

- May import from \`application\` and \`domain\`; nothing imports back.
- Every adapter here implements a port owned by the application layer.
- \`auth/\` is the only place the auth provider is named. Swapping providers
  means writing a sibling adapter and re-binding it in \`src/composition.ts\`
  — never touching the layers above. Only the composition root may import
  from this folder.
`;

const CLERK_ADAPTER = `import { currentUser } from '@clerk/nextjs/server';

import type { AuthenticatedUser } from '@/application/ports/authenticated-user';
import type { CurrentUserProvider } from '@/application/ports/current-user-provider';

/**
 * Clerk adapter implementing the CurrentUserProvider port. This file (and
 * the interface layer's Clerk components) is the entire provider surface:
 * swapping providers means writing a sibling adapter and re-binding the
 * port in src/composition.ts — src/domain and src/application never move.
 */
export const clerkCurrentUser: CurrentUserProvider = {
  async getCurrentUser(): Promise<AuthenticatedUser | null> {
    const user = await currentUser();
    if (!user) return null;
    return {
      id: user.id,
      email: user.primaryEmailAddress?.emailAddress,
      displayName: user.fullName ?? user.username ?? undefined,
    };
  },
};
`;

function layout(projectName: string): string {
  return `import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { ClerkProvider } from '@clerk/nextjs';

import { appearance } from './theme';
import './globals.css';

export const metadata: Metadata = {
  title: '${projectName}',
  description: 'Scaffolded by pier — auth boarding for the keel fleet.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/*
          publishableKey is read per-request (not inlined at build), so one
          image serves every environment: keel injects the real key from
          Infisical at runtime, and the build only ever sees a dummy.
        */}
        <ClerkProvider
          dynamic
          publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
          appearance={appearance}
        >
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
`;
}

const THEME = `/**
 * Your app's visual identity — this file is yours to own and edit; pier
 * scaffolds it once and never comes back for it. Brand Clerk's prebuilt
 * components here (colors, radii, fonts, per-component overrides) via the
 * appearance API — https://clerk.com/docs/customization/overview
 *
 * Scope note: this themes the in-app widgets only. Transactional emails
 * (OTP, magic link, password reset, verification) are sent by Clerk's
 * servers, so their branding is configured on the Clerk instance
 * (Dashboard), not here — it cannot live in this repo.
 */
export const appearance = {
  variables: {
    colorPrimary: '#0f172a',
  },
};
`;

const GLOBALS_CSS = `:root {
  color-scheme: light dark;
}

body {
  margin: 0;
  font-family:
    system-ui,
    -apple-system,
    sans-serif;
}

main {
  max-width: 40rem;
  margin: 0 auto;
  padding: 4rem 1.5rem;
}

main.centered {
  display: flex;
  justify-content: center;
}
`;

function homePage(projectName: string): string {
  // <Show> is the Core 3 (@clerk/nextjs v7) auth-state component; SignedIn /
  // SignedOut no longer exist there — caught by building this scaffold live.
  return `import Link from 'next/link';

import { Show, SignInButton, UserButton } from '@clerk/nextjs';

export default function HomePage() {
  return (
    <main>
      <h1>${projectName}</h1>
      <Show
        when="signed-in"
        fallback={
          <p>
            You are signed out. <SignInButton mode="modal" />
          </p>
        }
      >
        <p>
          <UserButton /> — you are signed in.
        </p>
        <p>
          <Link href="/dashboard">Go to the dashboard</Link> (protected route)
        </p>
      </Show>
    </main>
  );
}
`;
}

const SIGN_IN_PAGE = `import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <main className="centered">
      <SignIn />
    </main>
  );
}
`;

const SIGN_UP_PAGE = `import { SignUp } from '@clerk/nextjs';

export default function SignUpPage() {
  return (
    <main className="centered">
      <SignUp />
    </main>
  );
}
`;

const DASHBOARD_PAGE = `import { currentUserProvider } from '@/composition';

/**
 * Example protected route. src/proxy.ts already guards /dashboard; the page
 * itself depends on the port (via the composition root), never on the
 * provider or its adapter directly.
 */
export default async function DashboardPage() {
  const user = await currentUserProvider.getCurrentUser();
  if (!user) return null;
  return (
    <main>
      <h1>Dashboard</h1>
      <p>Signed in as {user.displayName ?? user.email ?? user.id}.</p>
    </main>
  );
}
`;

/**
 * The generated app's pipeline, wired to keel's deploy contract: merge to
 * main builds one image and pushes it to every non-production environment's
 * registry; a vX.Y.Z tag pushes to prod's. Deploying stays a reviewable
 * tfvars change in the infrastructure repo (keel's own step 3). Pushes gate
 * themselves on the SCW_SECRET_KEY secret, so the pipeline degrades to
 * build-only until Phase D (or the user) configures the repo.
 */
const APP_CI = `name: CI

on:
  push:
    branches: [main]
    tags: ['v*.*.*']
  pull_request:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - name: Build (dummy publishable key — real keys are runtime-injected)
        env:
          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: pk_test_Y2xlcmsuZXhhbXBsZS5jb20k
        run: npm run build

  image:
    needs: verify
    runs-on: ubuntu-latest
    env:
      SCW_SECRET_KEY: \${{ secrets.SCW_SECRET_KEY }}
    steps:
      - uses: actions/checkout@v5
      - name: Build the image
        run: docker build -t app:local .
      - name: Push to the keel environment registries
        if: github.event_name == 'push' && env.SCW_SECRET_KEY != ''
        env:
          REGISTRY_HOST: rg.\${{ vars.SCW_REGION }}.scw.cloud
          PROJECT_NAME: \${{ vars.PROJECT_NAME }}
          NON_PROD_ENVS: \${{ vars.KEEL_NON_PROD_ENVIRONMENTS }}
        run: |
          set -euo pipefail
          if [ "\${GITHUB_REF_TYPE}" = "tag" ]; then
            envs="prod"
            tag="\${GITHUB_REF_NAME}"
          else
            envs="\${NON_PROD_ENVS}"
            tag="main-\${GITHUB_SHA::7}"
          fi
          echo "\${SCW_SECRET_KEY}" | docker login "\${REGISTRY_HOST}" -u nologin --password-stdin
          for env in \${envs}; do
            ref="\${REGISTRY_HOST}/\${PROJECT_NAME}-\${env}/app:\${tag}"
            docker tag app:local "\${ref}"
            docker push "\${ref}"
            echo "::notice::Pushed \${ref} — set container_image in \${env}.tfvars to deploy it."
          done
`;

function readme(projectName: string): string {
  return `# ${projectName}

Next.js app bootstrapped by [pier](https://github.com/Gambi97/pier), with
authentication (Clerk) behind a DDD seam. Pier ran once and left — it is not
a dependency of this repo; everything here is yours.

## Layout

- \`src/domain\` — the core model. No framework, no provider, no I/O.
- \`src/application\` — use cases and ports. \`ports/\` owns the interfaces
  (\`CurrentUserProvider\`) and the \`AuthenticatedUser\` view — the only
  shape of the signed-in user the inner layers see.
- \`src/infrastructure\` — adapters implementing the application's ports.
  \`auth/\` is the only place the auth provider is named.
- \`src/composition.ts\` — the composition root: the one file where ports
  are bound to concrete adapters.
- \`src/app\` + \`src/proxy.ts\` — the Next.js interface layer: routing,
  pages, route protection. Depends on ports via the composition root, never
  on adapters directly.

Two rules keep the layout honest, both enforced by pier's tests: **nothing
under \`src/domain\` or \`src/application\` may import the auth provider**,
and **only the composition root may import from \`src/infrastructure\`**.
Swapping Clerk for another provider = a sibling adapter, one line in
\`src/composition.ts\`, and the interface-layer Clerk components.

## Develop

\`\`\`sh
npm install
npx clerk env pull --app <app id>   # writes Clerk keys to .env.local (gitignored)
npm run dev
\`\`\`

Secrets never live in this repo: local dev reads \`.env.local\`, deploys get
the same variables injected from the secret store. \`.env.example\` documents
the contract.

## Auth routes

- \`/sign-in\`, \`/sign-up\` — Clerk's prebuilt pages, themed in
  \`src/app/theme.ts\`.
- \`/dashboard\` — example protected route; add more to the matcher in
  \`src/proxy.ts\`.

## Branding is yours

Pier wired the auth plumbing and left; the look is entirely your call.

- **In-app widgets** (\`<SignIn>\`, \`<UserButton>\`, …) — edit
  \`src/app/theme.ts\` (Clerk's \`appearance\` API). This is app code you own.
- **Transactional emails** (OTP, magic link, password reset, verification) —
  sent by Clerk's servers, so their branding is configured on the Clerk
  instance (Dashboard → Customization), not in this repo. Clerk owns the
  sending; you own the look; pier touches neither.

## Deploy (keel)

One portable image serves every environment: the build uses a dummy
publishable key, the real \`CLERK_*\` keys are injected at runtime by keel
from Infisical (pier put them there). The image listens on 8080, keel's
\`container_port\` default.

- **Merge to main** → CI builds the image and pushes
  \`rg.<region>.scw.cloud/<project>-<env>/app:main-<sha>\` to every
  non-production environment registry.
- **Tag \`vX.Y.Z\`** → CI pushes \`<project>-prod/app:vX.Y.Z\`.
- **Deploying** stays a reviewable change in the infrastructure repo: set
  \`container_image\` in \`<env>.tfvars\` to the pushed ref (the CI run
  prints it) and merge.

The push needs the \`SCW_SECRET_KEY\` repo secret plus the \`SCW_REGION\`,
\`PROJECT_NAME\` and \`KEEL_NON_PROD_ENVIRONMENTS\` variables — pier sets
them at bootstrap when it can; until then CI still builds the image and
skips the push.
`;
}
