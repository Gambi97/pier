import { describe, expect, it } from 'vitest';

import { ScalewayError, validateScalewaySecretKey, type Fetcher } from './scaleway.js';

function fakeFetch(
  status: number,
  body?: unknown,
): {
  fetcher: Fetcher;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: Fetcher = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), { status }),
    );
  };
  return { fetcher, calls };
}

describe('validateScalewaySecretKey', () => {
  it('probes the registry of the given region with the key as X-Auth-Token', async () => {
    const { fetcher, calls } = fakeFetch(200);
    await validateScalewaySecretKey('the-key', 'nl-ams', fetcher);
    const call = calls[0]!;
    expect(call.url).toContain('/registry/v1/regions/nl-ams/namespaces');
    expect((call.init.headers as Record<string, string>)['X-Auth-Token']).toBe('the-key');
  });

  it.each([401, 403])('maps HTTP %i to a re-askable auth error', async (status) => {
    const { fetcher } = fakeFetch(status);
    const failure = validateScalewaySecretKey('bad', 'fr-par', fetcher);
    await expect(failure).rejects.toThrow(ScalewayError);
    await expect(failure).rejects.toMatchObject({ code: 'auth' });
  });

  it('returns the namespace names so the caller can spot missing registries', async () => {
    const { fetcher } = fakeFetch(200, {
      namespaces: [{ name: 'pizza-dev' }, { name: 'pizza-staging' }],
    });
    await expect(validateScalewaySecretKey('k', 'fr-par', fetcher)).resolves.toEqual([
      'pizza-dev',
      'pizza-staging',
    ]);
  });

  it('tolerates a bodyless 200 (no namespaces yet)', async () => {
    const { fetcher } = fakeFetch(200);
    await expect(validateScalewaySecretKey('k', 'fr-par', fetcher)).resolves.toEqual([]);
  });

  it('maps any other failure to a retryable api error', async () => {
    const { fetcher } = fakeFetch(503);
    await expect(validateScalewaySecretKey('k', 'fr-par', fetcher)).rejects.toMatchObject({
      code: 'api',
    });
  });
});
