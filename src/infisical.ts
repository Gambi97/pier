import { ConfigError } from './config.js';

/**
 * Phase B — push the Clerk keys into the Infisical project keel provisioned.
 *
 * Everything here mirrors keel's own Infisical driver (keel
 * src/bootstrap/infisical.ts) on purpose — same REST endpoints, same
 * Universal Auth machine identity, same never-overwrite semantics — so the
 * two bootstrappers speak one convention:
 *
 * - Coordinates arrive in the same env vars keel writes into the infra
 *   repo's CI: INFISICAL_CLIENT_ID / INFISICAL_CLIENT_SECRET (secrets),
 *   INFISICAL_PROJECT_ID / INFISICAL_HOST (variables).
 * - Pier NEVER creates the project: keel owns it. No ID → find by exact
 *   name (keel names the project after the app), and fail loudly telling
 *   the user to run keel first.
 * - Secrets are additive: an existing value is kept, never overwritten —
 *   a re-run cannot clobber a rotated key.
 * - keel's env slugs: dev / staging / prod, prod deploys on version tag.
 *   Non-production environments get the Clerk development-instance keys;
 *   prod gets keel-style placeholders (the production Clerk instance needs
 *   its own Google OAuth client and DNS before its keys exist).
 */

/** Which input a failure points at, so prompts can re-ask just that (keel's convention). */
export type InfisicalErrorField = 'credentials' | 'project';

export class InfisicalError extends Error {
  constructor(
    message: string,
    readonly field: InfisicalErrorField = 'credentials',
  ) {
    super(message);
  }
}

export const INFISICAL_DEFAULT_HOST = 'https://app.infisical.com';

/** keel's production slug; every other environment is non-production. */
export const PROD_SLUG = 'prod';

export const PROD_PLACEHOLDER = 'placeholder-set-after-clerk-production-setup';

export const CLERK_SECRET_NAMES = [
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'CLERK_SECRET_KEY',
] as const;

export interface InfisicalCoordinates {
  host: string;
  clientId: string;
  clientSecret: string;
  /** Explicit project ID; without one the project is found by exact name. */
  projectId?: string;
}

/**
 * Reads the keel-emitted coordinates from the environment. All-or-nothing:
 * absent credentials mean "skip Phase B" (undefined), a half-set pair is a
 * configuration mistake and throws.
 */
export function readInfisicalCoordinates(
  env: Record<string, string | undefined>,
): InfisicalCoordinates | undefined {
  const clientId = env.INFISICAL_CLIENT_ID?.trim();
  const clientSecret = env.INFISICAL_CLIENT_SECRET?.trim();
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    throw new ConfigError(
      'Set both INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET (the keel machine identity) — ' +
        'one without the other cannot authenticate.',
    );
  }
  return {
    host: env.INFISICAL_HOST?.trim() || INFISICAL_DEFAULT_HOST,
    clientId,
    clientSecret,
    projectId: env.INFISICAL_PROJECT_ID?.trim() || undefined,
  };
}

/**
 * Pulls the two Clerk keys out of the .env.local `clerk env pull` wrote.
 * Outside a Next.js project the CLI names the publishable key generically
 * (CLERK_PUBLISHABLE_KEY); accept it as a fallback for the NEXT_PUBLIC_
 * name so the push never trips over the CLI's framework detection.
 */
export function extractClerkKeys(envFileContent: string): Record<string, string> {
  const all: Record<string, string> = {};
  for (const line of envFileContent.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, name, rawValue] = match;
    const value = rawValue!.replace(/^["']|["']$/g, '');
    if (value) all[name!] = value;
  }
  const keys: Record<string, string> = {};
  for (const name of CLERK_SECRET_NAMES) {
    if (all[name]) keys[name] = all[name];
  }
  if (!keys.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && all.CLERK_PUBLISHABLE_KEY) {
    keys.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = all.CLERK_PUBLISHABLE_KEY;
  }
  return keys;
}

export interface SecretPush {
  environment: string;
  name: string;
  value: string;
}

/**
 * The full push plan, pure and testable: real dev-instance keys to every
 * non-production environment, placeholders to prod so the paths exist and
 * the production deploy has something to overwrite.
 */
export function buildSecretPlan(
  environmentSlugs: string[],
  clerkKeys: Record<string, string>,
): SecretPush[] {
  const plan: SecretPush[] = [];
  for (const slug of environmentSlugs) {
    for (const name of CLERK_SECRET_NAMES) {
      plan.push({
        environment: slug,
        name,
        value: slug === PROD_SLUG ? PROD_PLACEHOLDER : clerkKeys[name]!,
      });
    }
  }
  return plan;
}

interface InfisicalProject {
  id: string;
  name: string;
  environments?: { name: string; slug: string }[];
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export class InfisicalClient {
  private readonly coords: InfisicalCoordinates;
  private readonly fetcher: Fetcher;
  private token: string | undefined;

  constructor(coords: InfisicalCoordinates, fetcher: Fetcher = (url, init) => fetch(url, init)) {
    this.coords = coords;
    this.fetcher = fetcher;
  }

  private async api<T>(
    path: string,
    options: { method?: string; body?: unknown; auth?: boolean } = {},
  ): Promise<{ status: number; data: T & { message?: string } }> {
    const response = await this.fetcher(`${this.coords.host}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.auth === false ? {} : { Authorization: `Bearer ${await this.login()}` }),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    let data: T & { message?: string };
    try {
      data = (text ? JSON.parse(text) : {}) as T & { message?: string };
    } catch {
      data = {} as T & { message?: string };
    }
    return { status: response.status, data };
  }

  /** Universal Auth login with the keel machine identity; token is cached. */
  async login(): Promise<string> {
    if (this.token) return this.token;
    const { status, data } = await this.api<{ accessToken?: string }>(
      '/api/v1/auth/universal-auth/login',
      {
        method: 'POST',
        auth: false,
        body: { clientId: this.coords.clientId, clientSecret: this.coords.clientSecret },
      },
    );
    if (status !== 200 || !data.accessToken) {
      throw new InfisicalError(
        `Infisical Universal Auth login failed on ${this.coords.host} ` +
          `(HTTP ${status}${data.message ? `: ${data.message}` : ''}). ` +
          'Check the keel machine identity client ID/secret — and that the host is the ' +
          'one keel used (US/EU/self-hosted).',
      );
    }
    this.token = data.accessToken;
    return this.token;
  }

  /**
   * Resolves the keel project: by ID when given, by exact name otherwise —
   * the same find-or-create order keel uses, minus the create.
   */
  async resolveProject(projectName: string): Promise<{ id: string; environments: string[] }> {
    const { status, data } = await this.api<{ workspaces?: InfisicalProject[] }>(
      '/api/v1/workspace',
    );
    if (status !== 200) {
      throw new InfisicalError(`Could not list Infisical projects (HTTP ${status}).`);
    }
    const projects = data.workspaces ?? [];
    const project = this.coords.projectId
      ? projects.find((w) => w.id === this.coords.projectId)
      : projects.find((w) => w.name === projectName);
    if (!project) {
      throw new InfisicalError(
        this.coords.projectId
          ? `Infisical project "${this.coords.projectId}" was not found or the machine identity ` +
              'has no access to it.'
          : `No Infisical project named "${projectName}" — keel creates it; run keel first ` +
              '(or set INFISICAL_PROJECT_ID explicitly).',
        'project',
      );
    }
    return {
      id: project.id,
      environments: (project.environments ?? []).map((e) => e.slug),
    };
  }

  /**
   * Reads one secret's value; absent (or unreadable) resolves to undefined
   * — used to pick up the APP_URL keel's pipeline syncs after each apply.
   */
  async getSecret(
    projectId: string,
    environment: string,
    name: string,
  ): Promise<string | undefined> {
    const query = `workspaceId=${projectId}&environment=${environment}&secretPath=/`;
    const { status, data } = await this.api<{ secret?: { secretValue?: string } }>(
      `/api/v3/secrets/raw/${name}?${query}`,
    );
    if (status === 200) return data.secret?.secretValue;
    if (status === 400 || status === 404) return undefined;
    throw new InfisicalError(
      `Could not read ${name} from "${environment}" (HTTP ${status}${data.message ? `: ${data.message}` : ''}).`,
    );
  }

  /**
   * Creates one secret; an existing one is kept untouched (keel's additive
   * convention — a re-run must never clobber a rotated key).
   */
  async pushSecret(projectId: string, push: SecretPush): Promise<'created' | 'kept'> {
    const { status, data } = await this.api<Record<string, never>>(
      `/api/v3/secrets/raw/${push.name}`,
      {
        method: 'POST',
        body: {
          workspaceId: projectId,
          environment: push.environment,
          secretPath: '/',
          secretValue: push.value,
          type: 'shared',
        },
      },
    );
    if (status === 200) return 'created';
    if (status === 400 && /exist/i.test(data.message ?? '')) return 'kept';
    throw new InfisicalError(
      `Could not push ${push.name} to "${push.environment}" ` +
        `(HTTP ${status}${data.message ? `: ${data.message}` : ''}).`,
    );
  }
}
