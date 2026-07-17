import { describe, expect, it } from 'vitest';

import { ConfigError } from './config.js';
import {
  CLERK_SECRET_NAMES,
  InfisicalClient,
  InfisicalError,
  PROD_PLACEHOLDER,
  buildSecretPlan,
  extractClerkKeys,
  readInfisicalCoordinates,
  type Fetcher,
} from './infisical.js';

const COORDS = {
  host: 'https://infisical.test',
  clientId: 'ci',
  clientSecret: 'cs',
};

function fakeFetch(routes: Record<string, { status: number; body: unknown }>): {
  fetcher: Fetcher;
  calls: { url: string; body?: unknown }[];
} {
  const calls: { url: string; body?: unknown }[] = [];
  const fetcher: Fetcher = (url, init) => {
    const body = init.body ? (JSON.parse(init.body as string) as unknown) : undefined;
    calls.push({ url, body });
    const route = Object.entries(routes).find(([path]) => url.includes(path));
    if (!route) throw new Error(`fakeFetch: no route for ${url}`);
    const [, response] = route;
    return Promise.resolve(
      new Response(JSON.stringify(response.body), { status: response.status }),
    );
  };
  return { fetcher, calls };
}

const LOGIN_OK = { '/auth/universal-auth/login': { status: 200, body: { accessToken: 't' } } };

describe('readInfisicalCoordinates', () => {
  it('returns undefined when the keel credentials are absent', () => {
    expect(readInfisicalCoordinates({})).toBeUndefined();
  });

  it('throws on a half-set credential pair', () => {
    expect(() => readInfisicalCoordinates({ INFISICAL_CLIENT_ID: 'x' })).toThrow(ConfigError);
  });

  it('reads the same variable names keel emits, with the public host as default', () => {
    expect(
      readInfisicalCoordinates({
        INFISICAL_CLIENT_ID: ' ci ',
        INFISICAL_CLIENT_SECRET: 'cs',
        INFISICAL_PROJECT_ID: 'pid',
      }),
    ).toEqual({
      host: 'https://app.infisical.com',
      clientId: 'ci',
      clientSecret: 'cs',
      projectId: 'pid',
    });
  });
});

describe('extractClerkKeys', () => {
  it('parses the .env.local clerk env pull writes, ignoring everything else', () => {
    const keys = extractClerkKeys(
      [
        '# Clerk',
        'NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in',
        'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_abc',
        'CLERK_SECRET_KEY="sk_test_xyz"',
        'OTHER=value',
      ].join('\n'),
    );
    expect(keys).toEqual({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_abc',
      CLERK_SECRET_KEY: 'sk_test_xyz',
    });
  });

  it('falls back to the generic publishable-key name the CLI writes outside Next.js', () => {
    const keys = extractClerkKeys(
      ['CLERK_PUBLISHABLE_KEY=pk_test_abc', 'CLERK_SECRET_KEY=sk_test_xyz'].join('\n'),
    );
    expect(keys).toEqual({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_abc',
      CLERK_SECRET_KEY: 'sk_test_xyz',
    });
  });
});

describe('buildSecretPlan', () => {
  it('sends real keys to non-prod environments and placeholders to prod', () => {
    const plan = buildSecretPlan(['dev', 'staging', 'prod'], {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk',
      CLERK_SECRET_KEY: 'sk',
    });
    expect(plan).toHaveLength(6);
    for (const push of plan) {
      if (push.environment === 'prod') {
        expect(push.value).toBe(PROD_PLACEHOLDER);
      } else {
        expect(push.value).toBe(push.name === 'CLERK_SECRET_KEY' ? 'sk' : 'pk');
      }
    }
    expect(plan.map((s) => s.name).filter((n) => n === CLERK_SECRET_NAMES[0])).toHaveLength(3);
  });
});

describe('InfisicalClient', () => {
  it('fails login with a typed error pointing at the credentials, naming the host', async () => {
    const { fetcher } = fakeFetch({
      '/auth/universal-auth/login': { status: 401, body: { message: 'bad secret' } },
    });
    await expect(new InfisicalClient(COORDS, fetcher).login()).rejects.toMatchObject({
      field: 'credentials',
      message: expect.stringContaining(COORDS.host),
    });
  });

  it('resolves the project by exact name when no ID is given (keel convention)', async () => {
    const { fetcher } = fakeFetch({
      ...LOGIN_OK,
      '/api/v1/workspace': {
        status: 200,
        body: {
          workspaces: [
            {
              id: 'pid-1',
              name: 'pizza',
              environments: [
                { name: 'Development', slug: 'dev' },
                { name: 'Production', slug: 'prod' },
              ],
            },
          ],
        },
      },
    });
    const project = await new InfisicalClient(COORDS, fetcher).resolveProject('pizza');
    expect(project).toEqual({ id: 'pid-1', environments: ['dev', 'prod'] });
  });

  it('never creates the project: a missing one points at keel', async () => {
    const { fetcher } = fakeFetch({
      ...LOGIN_OK,
      '/api/v1/workspace': { status: 200, body: { workspaces: [] } },
    });
    await expect(
      new InfisicalClient(COORDS, fetcher).resolveProject('pizza'),
    ).rejects.toMatchObject(
      // field 'project' so the prompt re-asks the project, not the credentials.
      { field: 'project', message: expect.stringMatching(/run keel first/) },
    );
  });

  it('resolves by explicit ID and fails loudly when inaccessible', async () => {
    const { fetcher } = fakeFetch({
      ...LOGIN_OK,
      '/api/v1/workspace': {
        status: 200,
        body: { workspaces: [{ id: 'other', name: 'pizza' }] },
      },
    });
    const client = new InfisicalClient({ ...COORDS, projectId: 'pid-x' }, fetcher);
    await expect(client.resolveProject('pizza')).rejects.toThrow(/no access/);
  });

  it('creates a secret with the keel payload shape, logging in once', async () => {
    const { fetcher, calls } = fakeFetch({
      ...LOGIN_OK,
      '/api/v3/secrets/raw/': { status: 200, body: {} },
    });
    const client = new InfisicalClient(COORDS, fetcher);
    const push = { environment: 'dev', name: 'CLERK_SECRET_KEY', value: 'sk' };
    expect(await client.pushSecret('pid-1', push)).toBe('created');
    expect(await client.pushSecret('pid-1', push)).toBe('created');
    expect(calls.filter((c) => c.url.includes('/login'))).toHaveLength(1);
    const secretCall = calls.find((c) => c.url.includes('/secrets/raw/CLERK_SECRET_KEY'));
    expect(secretCall?.body).toEqual({
      workspaceId: 'pid-1',
      environment: 'dev',
      secretPath: '/',
      secretValue: 'sk',
      type: 'shared',
    });
  });

  it('keeps an existing secret instead of overwriting it', async () => {
    const { fetcher } = fakeFetch({
      ...LOGIN_OK,
      '/api/v3/secrets/raw/': { status: 400, body: { message: 'Secret already exists' } },
    });
    const client = new InfisicalClient(COORDS, fetcher);
    expect(await client.pushSecret('pid-1', { environment: 'dev', name: 'X', value: 'v' })).toBe(
      'kept',
    );
  });

  it('reads a secret value and treats an absent one as undefined', async () => {
    const hit = fakeFetch({
      ...LOGIN_OK,
      '/api/v3/secrets/raw/APP_URL': {
        status: 200,
        body: { secret: { secretValue: 'https://dev.example.com' } },
      },
    });
    const client = new InfisicalClient(COORDS, hit.fetcher);
    expect(await client.getSecret('pid-1', 'dev', 'APP_URL')).toBe('https://dev.example.com');
    const url = hit.calls.find((c) => c.url.includes('APP_URL'))!.url;
    expect(url).toContain('workspaceId=pid-1');
    expect(url).toContain('environment=dev');

    const miss = fakeFetch({
      ...LOGIN_OK,
      '/api/v3/secrets/raw/APP_URL': { status: 404, body: { message: 'not found' } },
    });
    const client2 = new InfisicalClient(COORDS, miss.fetcher);
    expect(await client2.getSecret('pid-1', 'dev', 'APP_URL')).toBeUndefined();
  });

  it('surfaces any other failure as a typed error', async () => {
    const { fetcher } = fakeFetch({
      ...LOGIN_OK,
      '/api/v3/secrets/raw/': { status: 403, body: { message: 'forbidden' } },
    });
    const client = new InfisicalClient(COORDS, fetcher);
    await expect(
      client.pushSecret('pid-1', { environment: 'dev', name: 'X', value: 'v' }),
    ).rejects.toThrow(InfisicalError);
  });
});
