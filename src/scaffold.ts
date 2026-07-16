import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
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
    '.gitignore': GITIGNORE,
    '.env.example': ENV_EXAMPLE,
    '.env.local': ENV_LOCAL,
    'README.md': readme(projectName),
    'src/proxy.ts': PROXY,
    'src/domain/README.md': DOMAIN_README,
    'src/application/README.md': APPLICATION_README,
    'src/application/ports/authenticated-user.ts': AUTHENTICATED_USER_PORT,
    'src/infrastructure/README.md': INFRASTRUCTURE_README,
    'src/infrastructure/auth/clerk-current-user.ts': CLERK_ADAPTER,
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

const nextConfig: NextConfig = {};

export default nextConfig;
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
- Ports are defined here, implemented in \`infrastructure\`.
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

const INFRASTRUCTURE_README = `# Infrastructure

Adapters: implementations of the application layer's ports against real
providers (auth, persistence, ...).

Rules:

- May import from \`application\` and \`domain\`; nothing imports back.
- \`auth/\` is the only place the auth provider is named. Swapping providers
  means rewriting this folder and the interface edge — never the layers above.
`;

const CLERK_ADAPTER = `import { currentUser } from '@clerk/nextjs/server';

import type { AuthenticatedUser } from '@/application/ports/authenticated-user';

/**
 * Clerk adapter behind the auth seam. This file (and the interface layer)
 * is the entire provider surface: swapping Clerk for another provider must
 * not touch src/domain or src/application.
 */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const user = await currentUser();
  if (!user) return null;
  return {
    id: user.id,
    email: user.primaryEmailAddress?.emailAddress,
    displayName: user.fullName ?? user.username ?? undefined,
  };
}
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
        <ClerkProvider appearance={appearance}>{children}</ClerkProvider>
      </body>
    </html>
  );
}
`;
}

const THEME = `/**
 * Theme placeholder: brand Clerk's prebuilt components here (colors, radii,
 * fonts, per-component overrides) via the appearance API —
 * https://clerk.com/docs/customization/overview
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

const DASHBOARD_PAGE = `import { getCurrentUser } from '@/infrastructure/auth/clerk-current-user';

/**
 * Example protected route. src/proxy.ts already guards /dashboard; the page
 * itself only talks to the app-owned seam, never to the provider directly.
 */
export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  return (
    <main>
      <h1>Dashboard</h1>
      <p>Signed in as {user.displayName ?? user.email ?? user.id}.</p>
    </main>
  );
}
`;

function readme(projectName: string): string {
  return `# ${projectName}

Next.js app bootstrapped by [pier](https://github.com/Gambi97/pier), with
authentication (Clerk) behind a DDD seam. Pier ran once and left — it is not
a dependency of this repo; everything here is yours.

## Layout

- \`src/domain\` — the core model. No framework, no provider, no I/O.
- \`src/application\` — use cases and ports. \`ports/authenticated-user.ts\`
  is the only view of the signed-in user the inner layers see.
- \`src/infrastructure\` — adapters. \`auth/\` is the only place the auth
  provider is named.
- \`src/app\` + \`src/proxy.ts\` — the Next.js interface layer: routing,
  pages, route protection.

The rule that keeps the layout honest: **nothing under \`src/domain\` or
\`src/application\` may import the auth provider.** Swapping Clerk for
another provider touches \`src/infrastructure/auth\` and the interface layer
only.

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
`;
}
