import { describe, expect, it } from 'vitest';

import { ClerkCli, ClerkError, type Runner, type RunResult } from './clerk.js';

function fakeRunner(responses: Record<string, RunResult>): {
  runner: Runner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: Runner = (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(' ');
    const found = responses[key];
    if (!found) throw new Error(`fakeRunner: no response for "${key}"`);
    return Promise.resolve(found);
  };
  return { runner, calls };
}

const ok = (stdout: string): RunResult => ({ status: 0, stdout, stderr: '' });

describe('ClerkCli', () => {
  it('creates an app and returns id + name', async () => {
    const { runner, calls } = fakeRunner({
      'apps create': ok(JSON.stringify({ id: 'app_123', name: 'pizza' })),
    });
    const app = await new ClerkCli('ak_x', runner).createApp('pizza');
    expect(app).toEqual({ id: 'app_123', name: 'pizza' });
    // Headless contract: agent mode on every call.
    expect(calls[0]).toContain('--mode');
    expect(calls[0]).toContain('agent');
  });

  it('patches config with --yes and the JSON payload', async () => {
    const { runner, calls } = fakeRunner({ 'config patch': ok('') });
    await new ClerkCli('ak_x', runner).patchConfig('app_123', {
      auth_email: { enabled: true },
    });
    const args = calls[0]!;
    expect(args).toContain('--yes');
    expect(args).toContain('--app');
    expect(args).toContain(JSON.stringify({ auth_email: { enabled: true } }));
  });

  it('maps agent-mode auth errors to a typed auth failure', async () => {
    const { runner } = fakeRunner({
      'apps list': {
        status: 1,
        stdout: JSON.stringify({
          error: { code: 'auth_required', message: 'Not authenticated' },
        }),
        stderr: '',
      },
    });
    await expect(new ClerkCli('ak_x', runner).validateKey()).rejects.toMatchObject({
      code: 'auth',
      message: 'Not authenticated',
    });
  });

  it('maps a missing binary to not-installed', async () => {
    const runner: Runner = () => Promise.resolve({ status: 127, stdout: '', stderr: '' });
    await expect(new ClerkCli('ak_x', runner).validateKey()).rejects.toMatchObject({
      code: 'not-installed',
    });
  });

  it('rejects non-JSON where JSON is promised', async () => {
    const { runner } = fakeRunner({ 'apps create': ok('not json') });
    await expect(new ClerkCli('ak_x', runner).createApp('x')).rejects.toBeInstanceOf(ClerkError);
  });
});

/**
 * Live schema pinning: runs only when a real platform key is exported.
 * First run with an ak_ key confirms (or corrects) the provisional
 * auth_email keys in methods.ts.
 */
describe.skipIf(!process.env.CLERK_PLATFORM_API_KEY)(
  'live schema (needs CLERK_PLATFORM_API_KEY)',
  () => {
    it('knows the keys methods.ts relies on', async () => {
      const clerk = new ClerkCli(process.env.CLERK_PLATFORM_API_KEY!);
      const keys = await clerk.schemaKeys();
      expect(keys).toContain('connection_oauth_google');
      expect(keys).toContain('auth_email');
    }, 60_000);
  },
);
