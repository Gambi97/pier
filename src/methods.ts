/**
 * Auth methods Pier can enable, each mapped to the instance-config fragment
 * `clerk config patch` applies.
 *
 * Only `google` uses a key verified against Clerk's published examples
 * (`connection_oauth_google`). The email-based fragments follow the same
 * schema family but are still provisional: before patching, Pier pulls
 * `clerk config schema` and drops any fragment whose top-level key the
 * schema does not know, warning instead of guessing. First real run against
 * a platform key should pin them (see the live test in methods.test.ts).
 */

export type AuthMethod = 'google' | 'password' | 'magic-link' | 'email-otp';

export const AUTH_METHODS: readonly AuthMethod[] = [
  'google',
  'password',
  'magic-link',
  'email-otp',
];

interface MethodSpec {
  /** Top-level instance-config key the fragment lives under. */
  key: string;
  fragment: Record<string, unknown>;
  label: string;
}

const SPECS: Record<AuthMethod, MethodSpec> = {
  google: {
    key: 'connection_oauth_google',
    fragment: { connection_oauth_google: { enabled: true } },
    label: 'Google (shared credentials on dev; bring your own client for prod)',
  },
  password: {
    key: 'auth_email',
    fragment: { auth_email: { enabled: true, password: { enabled: true } } },
    label: 'Email + password',
  },
  'magic-link': {
    key: 'auth_email',
    fragment: { auth_email: { enabled: true, email_link: { enabled: true } } },
    label: 'Magic link',
  },
  'email-otp': {
    key: 'auth_email',
    fragment: { auth_email: { enabled: true, email_code: { enabled: true } } },
    label: 'Email OTP code',
  },
};

export function methodLabel(method: AuthMethod): string {
  return SPECS[method].label;
}

export interface PatchPlan {
  patch: Record<string, unknown>;
  /** Methods dropped because the live schema does not know their key. */
  dropped: AuthMethod[];
}

/**
 * Merge the selected methods into one PATCH payload, keeping only fragments
 * whose top-level key exists in the live schema. Fragments sharing a key
 * (the email family) deep-merge instead of overwriting each other.
 */
export function buildPatch(methods: AuthMethod[], schemaKeys: string[]): PatchPlan {
  const known = new Set(schemaKeys);
  const patch: Record<string, unknown> = {};
  const dropped: AuthMethod[] = [];
  for (const method of methods) {
    const spec = SPECS[method];
    if (!known.has(spec.key)) {
      dropped.push(method);
      continue;
    }
    for (const [key, value] of Object.entries(spec.fragment)) {
      const existing = patch[key];
      patch[key] = isRecord(existing) && isRecord(value) ? deepMerge(existing, value) : value;
    }
  }
  return { patch, dropped };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return out;
}
