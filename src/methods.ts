/**
 * Auth methods Pier can enable, mapped to Clerk's instance-config shape.
 *
 * Pinned live against `clerk config schema` (draft 2020-12, id
 * `platform-config/2025-01-01`) and verified end-to-end with a real
 * `config patch` + `config pull` round trip:
 *
 * - Google is a connection: `connection_oauth_google.enabled`. In
 *   development Clerk provides shared OAuth credentials (the schema says so
 *   explicitly); production wants `client_id`/`client_secret`.
 * - Password is its own top-level key: `auth_password.enabled`.
 * - Magic link and email OTP are not toggles but *strategies* in the
 *   `auth_email.sign_in_strategies` array (`email_link` / `email_code`), so
 *   selecting both means a two-element array, not two merged objects.
 *
 * Before patching, Pier still validates the top-level keys it is about to
 * write against the live schema and drops unknown ones loudly — the schema
 * is versioned and can move again.
 */

export type AuthMethod = 'google' | 'password' | 'magic-link' | 'email-otp';

export const AUTH_METHODS: readonly AuthMethod[] = [
  'google',
  'password',
  'magic-link',
  'email-otp',
];

const LABELS: Record<AuthMethod, string> = {
  google: 'Google (shared credentials on dev; bring your own client for prod)',
  password: 'Email + password',
  'magic-link': 'Magic link',
  'email-otp': 'Email OTP code',
};

export function methodLabel(method: AuthMethod): string {
  return LABELS[method];
}

export interface PatchPlan {
  patch: Record<string, unknown>;
  /** Methods dropped because the live schema does not know their key. */
  dropped: AuthMethod[];
  /** Degradations that are not full drops but the user must hear about. */
  warnings: string[];
}

/**
 * Build the PATCH payload for the selected methods, declaratively from the
 * whole selection (the email strategies are one array, so this cannot be a
 * per-method merge). `schemaKeys` are the top-level property names of the
 * live config schema.
 */
export function buildPatch(methods: AuthMethod[], schemaKeys: string[]): PatchPlan {
  const known = new Set(schemaKeys);
  const selected = new Set(methods);
  const patch: Record<string, unknown> = {};
  const dropped: AuthMethod[] = [];
  const warnings: string[] = [];

  if (selected.has('google')) {
    if (known.has('connection_oauth_google')) {
      patch.connection_oauth_google = { enabled: true };
    } else dropped.push('google');
  }

  if (selected.has('password')) {
    if (known.has('auth_password')) {
      patch.auth_password = { enabled: true };
    } else dropped.push('password');
  }

  const strategies: string[] = [];
  if (selected.has('email-otp')) strategies.push('email_code');
  if (selected.has('magic-link')) strategies.push('email_link');

  // The email block is needed for the passwordless strategies, and also as
  // the verified-identifier base whenever password sign-up is on.
  const needsEmail = strategies.length > 0 || selected.has('password');
  if (needsEmail) {
    if (known.has('auth_email')) {
      patch.auth_email = {
        used_for_sign_up: true,
        required_for_sign_up: true,
        verify_at_sign_up: true,
        verification_strategies: ['email_code'],
        ...(strategies.length > 0
          ? { used_for_sign_in: true, sign_in_strategies: strategies }
          : {}),
      };
    } else {
      for (const m of ['magic-link', 'email-otp'] as const) {
        if (selected.has(m)) dropped.push(m);
      }
      if (selected.has('password') && 'auth_password' in patch) {
        warnings.push(
          'The live schema has no "auth_email" key, so password sign-up is enabled without ' +
            'the verified-email base. Check email settings in the Clerk dashboard.',
        );
      }
    }
  }

  // Not an auth method but part of the same patch: point Clerk's hosted
  // flows at the routes the scaffold creates. Schema-guarded like the rest.
  if (known.has('paths')) {
    patch.paths = { home: '/', sign_in: '/sign-in', sign_up: '/sign-up' };
  }

  return { patch, dropped, warnings };
}
