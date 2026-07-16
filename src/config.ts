import { AUTH_METHODS, type AuthMethod } from './methods.js';

export class ConfigError extends Error {}

/** Same DNS-safe rule keel enforces, so `<project>` and `<project>-infrastructure` pair up. */
const PROJECT_NAME_RE = /^[a-z](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export interface Answers {
  /** Fleet project name; the Clerk application and the app repo share it. */
  projectName: string;
  methods: AuthMethod[];
  platformKey: string;
  dryRun: boolean;
}

export function validateProjectName(name: string): string {
  const trimmed = name.trim();
  if (!PROJECT_NAME_RE.test(trimmed) || trimmed.includes('--')) {
    throw new ConfigError(
      `Invalid project name "${trimmed}": use 1-50 lowercase letters, digits or single hyphens, ` +
        'starting with a letter and not ending with a hyphen (DNS-safe, same rule as keel).',
    );
  }
  return trimmed;
}

/**
 * The platform key is optional: without one, the Clerk CLI falls back to
 * the OAuth token a previous `clerk auth login` stored on this machine.
 * When a key IS given it must be the account-plane `ak_` kind — a secret
 * key (sk_...) authenticates a single instance and cannot create
 * applications or change auth configuration.
 */
export function validatePlatformKey(key: string | undefined): string | undefined {
  const trimmed = key?.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith('ak_')) {
    throw new ConfigError(
      'The platform API key must start with "ak_". A secret key (sk_...) authenticates a single ' +
        'instance and cannot create applications or change auth configuration — create a ' +
        'platform key in the Clerk Dashboard, or run `npx clerk auth login` once instead.',
    );
  }
  return trimmed;
}

export function validateMethods(raw: string[]): AuthMethod[] {
  const methods = raw.map((m) => m.trim()).filter(Boolean);
  if (methods.length === 0) {
    throw new ConfigError(`Pick at least one auth method (${AUTH_METHODS.join(', ')}).`);
  }
  const unknown = methods.filter((m) => !AUTH_METHODS.includes(m as AuthMethod));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown auth method${unknown.length > 1 ? 's' : ''} "${unknown.join('", "')}": ` +
        `valid values are ${AUTH_METHODS.join(', ')}.`,
    );
  }
  return [...new Set(methods)] as AuthMethod[];
}
