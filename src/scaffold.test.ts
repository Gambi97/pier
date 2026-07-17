import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigError } from './config.js';
import {
  detectExistingScaffold,
  ensureEmptyTarget,
  planScaffold,
  writeScaffold,
} from './scaffold.js';

const FILES = planScaffold('pizza');

describe('planScaffold', () => {
  it('plans the full DDD skeleton', () => {
    for (const required of [
      'package.json',
      'tsconfig.json',
      '.gitignore',
      '.env.example',
      'README.md',
      'AGENTS.md',
      'CLAUDE.md',
      'src/proxy.ts',
      'src/domain/README.md',
      'src/application/ports/authenticated-user.ts',
      'src/infrastructure/auth/clerk-current-user.ts',
      'src/app/layout.tsx',
      'src/app/sign-in/[[...sign-in]]/page.tsx',
      'src/app/sign-up/[[...sign-up]]/page.tsx',
      'src/app/dashboard/page.tsx',
    ]) {
      expect(Object.keys(FILES), required).toContain(required);
    }
  });

  it('keeps the DDD seam: domain and application never mention the provider', () => {
    for (const [path, content] of Object.entries(FILES)) {
      if (path.startsWith('src/domain/') || path.startsWith('src/application/')) {
        expect(content.toLowerCase().includes('clerk'), path).toBe(false);
      }
    }
  });

  it('confines provider imports to infrastructure and the interface layer', () => {
    for (const [path, content] of Object.entries(FILES)) {
      if (!content.includes("from '@clerk/")) continue;
      const isEdge =
        path.startsWith('src/infrastructure/') ||
        path.startsWith('src/app/') ||
        path === 'src/proxy.ts';
      expect(isEdge, path).toBe(true);
    }
  });

  it('keeps it hexagonal: the adapter implements the port, and only the composition root imports infrastructure', () => {
    expect(FILES['src/application/ports/current-user-provider.ts']).toContain(
      'interface CurrentUserProvider',
    );
    expect(FILES['src/infrastructure/auth/clerk-current-user.ts']).toContain(
      ': CurrentUserProvider',
    );
    for (const [path, content] of Object.entries(FILES)) {
      // The rule is scoped to src/ — the boundary-check script itself
      // contains the detection string, and it lives in scripts/.
      if (!path.startsWith('src/')) continue;
      if (!content.includes("from '@/infrastructure/")) continue;
      expect(path, path).toBe('src/composition.ts');
    }
    // Pages reach the port through the composition root.
    expect(FILES['src/app/dashboard/page.tsx']).toContain("from '@/composition'");
  });

  it('does not make pier a dependency of the generated repo', () => {
    const pkg = JSON.parse(FILES['package.json']!) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all).some((d) => d.includes('pier'))).toBe(false);
    expect(all['@clerk/nextjs']).toBeDefined();
    expect(all['next']).toBeDefined();
  });

  it('gitignores every env file except the example, and ships no key material', () => {
    const gitignore = FILES['.gitignore']!;
    expect(gitignore).toContain('.env*');
    expect(gitignore).toContain('!.env.example');
    // The documented dummy build key (base64 of clerk.example.com$) is the
    // one allowed exception — anything else key-shaped is a leak.
    const DUMMY = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k';
    for (const [path, content] of Object.entries(FILES)) {
      const scrubbed = content.replaceAll(DUMMY, '');
      expect(/(pk|sk|ak)_(test|live)?_?[A-Za-z0-9]{8,}/.test(scrubbed), path).toBe(false);
    }
  });

  it('ships a portable image: standalone output, port 8080, runtime keys', () => {
    expect(FILES['next.config.ts']).toContain("output: 'standalone'");
    const dockerfile = FILES['Dockerfile']!;
    expect(dockerfile).toContain('ENV PORT=8080');
    expect(dockerfile).toContain('CMD ["node", "server.js"]');
    // The publishable key must NOT be baked in as a real build requirement:
    // the layout reads it per-request instead.
    expect(FILES['src/app/layout.tsx']).toContain(
      'publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}',
    );
  });

  it("wires the app CI to keel's registry contract", () => {
    const ci = FILES['.github/workflows/ci.yml']!;
    expect(ci).toContain('docker login "${REGISTRY_HOST}" -u nologin');
    expect(ci).toContain('${PROJECT_NAME}-${env}/app:${tag}');
    expect(ci).toContain("tags: ['v*.*.*']");
    // Push degrades to build-only until the secret exists.
    expect(ci).toContain("env.SCW_SECRET_KEY != ''");
  });

  it('protects /dashboard in the proxy and names the project in the pages', () => {
    expect(FILES['src/proxy.ts']).toContain("'/dashboard(.*)'");
    expect(FILES['src/app/layout.tsx']).toContain("title: 'pizza'");
    expect(FILES['README.md']).toContain('# pizza');
  });
});

describe('writeScaffold', () => {
  it('writes the tree into a new directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'pier-scaffold-'));
    const dir = join(base, 'app');
    await writeScaffold(dir, FILES);
    const pkg = await readFile(join(dir, 'package.json'), 'utf8');
    expect(JSON.parse(pkg)).toMatchObject({ name: 'pizza', private: true });
    const adapter = await readFile(
      join(dir, 'src/infrastructure/auth/clerk-current-user.ts'),
      'utf8',
    );
    expect(adapter).toContain('@clerk/nextjs/server');
  });

  it('ships an agent manual that teaches the enforced rules', () => {
    const agents = FILES['AGENTS.md']!;
    expect(agents).toContain('check:boundaries');
    expect(agents).toContain('src/composition.ts');
    expect(agents).toContain('No secrets in this repo');
    // The keel↔Clerk environment asymmetry must reach whoever inherits the repo.
    expect(agents).toContain('one shared user pool');
    // One source of truth: CLAUDE.md imports AGENTS.md.
    expect(FILES['CLAUDE.md']).toContain('@AGENTS.md');
  });

  it('ships the boundary rules with the repo, and they actually bite', async () => {
    // The generated CI must run the check — rules travel with the handoff.
    expect(FILES['.github/workflows/ci.yml']).toContain('npm run check:boundaries');

    const base = await mkdtemp(join(tmpdir(), 'pier-bounds-'));
    const dir = join(base, 'app');
    await writeScaffold(dir, FILES);
    const run = () =>
      spawnSync('node', ['scripts/check-boundaries.mjs'], { cwd: dir, encoding: 'utf8' });

    // Clean scaffold passes.
    expect(run().status, run().stderr).toBe(0);

    // A provider leak into the inner layers fails the build...
    const leak = join(dir, 'src/domain/bad.ts');
    await writeFile(leak, "import { currentUser } from '@clerk/nextjs/server';\n");
    const leaked = run();
    expect(leaked.status).toBe(1);
    expect(leaked.stderr).toContain('inner layers must not mention the auth provider');
    await writeFile(leak, 'export {};\n');

    // ...and so does bypassing the composition root.
    await writeFile(
      join(dir, 'src/app/sneaky.ts'),
      "import { clerkCurrentUser } from '@/infrastructure/auth/clerk-current-user';\n",
    );
    const bypassed = run();
    expect(bypassed.status).toBe(1);
    expect(bypassed.stderr).toContain('only src/composition.ts may import from infrastructure');
  });

  it('recognizes its own scaffold for idempotent re-runs', async () => {
    const base = await mkdtemp(join(tmpdir(), 'pier-rerun-'));
    const dir = join(base, 'app');
    await writeScaffold(dir, FILES);
    expect(await detectExistingScaffold(dir, 'pizza')).toBe(true);
    expect(await detectExistingScaffold(dir, 'other-project')).toBe(false);
    expect(await detectExistingScaffold(join(base, 'missing'), 'pizza')).toBe(false);
  });

  it('accepts an existing empty directory and refuses a non-empty one', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'pier-empty-'));
    await expect(ensureEmptyTarget(empty)).resolves.toBeUndefined();

    const dirty = await mkdtemp(join(tmpdir(), 'pier-dirty-'));
    await writeFile(join(dirty, 'keep.txt'), 'x');
    await expect(writeScaffold(dirty, FILES)).rejects.toThrow(ConfigError);

    const notADir = join(await mkdtemp(join(tmpdir(), 'pier-file-')), 'f');
    await writeFile(notADir, 'x');
    await expect(ensureEmptyTarget(notADir)).rejects.toThrow(ConfigError);
  });
});
