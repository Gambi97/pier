import { describe, expect, it } from 'vitest';

import { ClerkCli, ClerkError, type Runner, type RunResult } from './clerk.js';

function fakeRunner(responses: Record<string, RunResult>): {
  runner: Runner;
  calls: string[][];
  envs: Record<string, string>[];
} {
  const calls: string[][] = [];
  const envs: Record<string, string>[] = [];
  const runner: Runner = (args, env) => {
    calls.push(args);
    envs.push(env);
    const key = args.slice(0, 2).join(' ');
    const found = responses[key];
    if (!found) throw new Error(`fakeRunner: no response for "${key}"`);
    return Promise.resolve(found);
  };
  return { runner, calls, envs };
}

const ok = (stdout: string): RunResult => ({ status: 0, stdout, stderr: '' });

// Real `apps create --json` payload shape, captured live on 2026-07-16.
const CREATED = JSON.stringify({
  application_id: 'app_123',
  name: 'pizza',
  instances: [
    {
      instance_id: 'ins_456',
      environment_type: 'development',
      publishable_key: 'pk_test_abc',
    },
  ],
});

describe('ClerkCli', () => {
  it('creates an app, reading the real application_id/instances payload', async () => {
    const { runner, calls } = fakeRunner({ 'apps create': ok(CREATED) });
    const app = await new ClerkCli('ak_x', runner).createApp('pizza');
    expect(app).toEqual({ id: 'app_123', name: 'pizza', devPublishableKey: 'pk_test_abc' });
    // Headless contract: agent mode on every call.
    expect(calls[0]).toContain('--mode');
    expect(calls[0]).toContain('agent');
  });

  it('tolerates the human preamble line agent mode prints before JSON', async () => {
    const { runner } = fakeRunner({
      'apps create': ok('Creating application...\n' + CREATED),
    });
    const app = await new ClerkCli('ak_x', runner).createApp('pizza');
    expect(app.id).toBe('app_123');
  });

  it('reads schema keys from the JSON Schema properties block', async () => {
    const { runner, calls } = fakeRunner({
      'config schema': ok(
        'Pulling config schema from pizza (development)...\n' +
          JSON.stringify({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: { auth_email: {}, auth_password: {}, connection_oauth_google: {} },
          }),
      ),
    });
    const keys = await new ClerkCli('ak_x', runner).schemaKeys('app_123');
    expect(keys.sort()).toEqual(['auth_email', 'auth_password', 'connection_oauth_google']);
    expect(calls[0]).toContain('--app');
  });

  it('unwraps the {config_version, config} envelope on pull', async () => {
    const { runner } = fakeRunner({
      'config pull': ok(
        JSON.stringify({
          config_version: 'v1_abc',
          config: { auth_password: { enabled: true } },
        }),
      ),
    });
    const config = await new ClerkCli('ak_x', runner).pullConfig('app_123');
    expect(config).toEqual({ auth_password: { enabled: true } });
  });

  it('patches config with --yes and the JSON payload', async () => {
    const { runner, calls } = fakeRunner({ 'config patch': ok('') });
    await new ClerkCli('ak_x', runner).patchConfig('app_123', {
      auth_password: { enabled: true },
    });
    const args = calls[0]!;
    expect(args).toContain('--yes');
    expect(args).toContain('--app');
    expect(args).toContain(JSON.stringify({ auth_password: { enabled: true } }));
  });

  it('passes the platform key through the env only when given', async () => {
    const withKey = fakeRunner({ 'apps list': ok('[]') });
    await new ClerkCli('ak_x', withKey.runner).validateKey();
    expect(withKey.envs[0]).toEqual({ CLERK_PLATFORM_API_KEY: 'ak_x' });

    // Without a key the CLI falls back to the stored OAuth login.
    const withoutKey = fakeRunner({ 'apps list': ok('[]') });
    await new ClerkCli(undefined, withoutKey.runner).validateKey();
    expect(withoutKey.envs[0]).toEqual({});
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
    await expect(new ClerkCli(undefined, runner).validateKey()).rejects.toMatchObject({
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

  it('rejects output with no JSON where JSON is promised', async () => {
    const { runner } = fakeRunner({ 'apps create': ok('no json here') });
    await expect(new ClerkCli('ak_x', runner).createApp('x')).rejects.toBeInstanceOf(ClerkError);
  });
});

/**
 * Live round trip against a real account. Gated: export PIER_LIVE_APP_ID
 * (an existing app id) and be authenticated (CLERK_PLATFORM_API_KEY or a
 * stored `clerk auth login`). Pins the schema keys methods.ts relies on.
 */
describe.skipIf(!process.env.PIER_LIVE_APP_ID)('live schema (needs PIER_LIVE_APP_ID)', () => {
  it('knows the keys methods.ts relies on', async () => {
    const clerk = new ClerkCli(process.env.CLERK_PLATFORM_API_KEY);
    const keys = await clerk.schemaKeys(process.env.PIER_LIVE_APP_ID!);
    expect(keys).toContain('connection_oauth_google');
    expect(keys).toContain('auth_password');
    expect(keys).toContain('auth_email');
  }, 120_000);
});
