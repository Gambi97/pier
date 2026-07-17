/**
 * Phase 0's Scaleway link — the registry credential the generated CI pushes
 * images with. keel collected the same key; pier verifies it up front
 * (keel's principle) instead of letting a bad or missing key surface as a
 * skipped push in a pipeline hours after everything here looked green.
 */

/** keel's own region contract — the registries live in one of these. */
export const SCW_REGIONS = ['fr-par', 'nl-ams', 'pl-waw'] as const;
export const SCW_DEFAULT_REGION = 'fr-par';

export type ScalewayErrorCode = 'auth' | 'api';

export class ScalewayError extends Error {
  readonly code: ScalewayErrorCode;

  constructor(message: string, code: ScalewayErrorCode) {
    super(message);
    this.code = code;
  }
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Read-only probe of the exact permission CI needs: list the region's
 * Container Registry namespaces with the secret key. 401/403 means the key
 * is wrong or cannot touch the registry; anything else non-2xx is the API
 * having a moment, not the operator's mistake. Returns the namespace names,
 * so the caller can say up front whether keel's registries exist yet — a
 * push to a missing namespace is a bare `denied` in CI, hours later.
 */
export async function validateScalewaySecretKey(
  secretKey: string,
  region: string,
  fetcher: Fetcher = (url, init) => fetch(url, init),
): Promise<string[]> {
  const response = await fetcher(
    `https://api.scaleway.com/registry/v1/regions/${region}/namespaces?page_size=100`,
    { headers: { 'X-Auth-Token': secretKey } },
  );
  if (response.status === 401 || response.status === 403) {
    throw new ScalewayError(
      `Scaleway rejected the secret key (HTTP ${response.status}) — the generated CI logs ` +
        'into the registry with it. Check SCW_SECRET_KEY (the same key keel used) and that ' +
        'it can manage Container Registry.',
      'auth',
    );
  }
  if (!response.ok) {
    throw new ScalewayError(
      `Scaleway API error while validating the key: HTTP ${response.status}.`,
      'api',
    );
  }
  const data = (await response.json().catch(() => ({}))) as {
    namespaces?: { name?: string }[];
  };
  return (data.namespaces ?? []).map((n) => n.name ?? '').filter(Boolean);
}
