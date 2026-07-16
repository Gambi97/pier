import { spawn } from 'node:child_process';

/**
 * Driver for the official `clerk` CLI (npm package `clerk`), which is the
 * published automation surface for both of Clerk's HTTP APIs:
 *
 * - Backend API (BAPI): instance-scoped, authenticates with a secret key
 *   (`sk_...`). Users, sessions, and a small set of instance meta-settings.
 * - Platform API (PLAPI): account-scoped, authenticates with a platform API
 *   key (`ak_...`) via CLERK_PLATFORM_API_KEY. Creating applications and all
 *   instance *configuration* (auth methods, social connections) live here —
 *   `config patch` does not accept a secret key at all.
 *
 * Pier is a run-once bootstrapper, so everything goes through the headless
 * path: `--mode agent`, `--json` where available, `--yes` on mutations. No
 * browser login, no dashboard.
 */

export type ClerkErrorCode = 'not-installed' | 'auth' | 'bad-input' | 'api';

export class ClerkError extends Error {
  readonly code: ClerkErrorCode;
  constructor(code: ClerkErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Injectable process runner so tests never spawn the real CLI. */
export type Runner = (args: string[], env: Record<string, string>) => Promise<RunResult>;

export const spawnRunner: Runner = (args, env) =>
  new Promise((resolve) => {
    const child = spawn('npx', ['--yes', 'clerk', ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', () => resolve({ status: 127, stdout, stderr }));
    child.on('close', (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });

export interface ClerkApp {
  id: string;
  name: string;
  /** Publishable key of the development instance, when the API returned one. */
  devPublishableKey?: string;
}

interface RawApp {
  application_id?: string;
  name?: string;
  instances?: { instance_id: string; environment_type: string; publishable_key: string }[];
}

function toClerkApp(raw: RawApp, fallbackName?: string): ClerkApp | undefined {
  if (!raw.application_id) return undefined;
  const dev = raw.instances?.find((i) => i.environment_type === 'development');
  return {
    id: raw.application_id,
    name: raw.name ?? fallbackName ?? '',
    devPublishableKey: dev?.publishable_key,
  };
}

export class ClerkCli {
  private readonly run: Runner;
  private readonly platformKey: string | undefined;

  /**
   * Platform-plane credential resolution mirrors the CLI's own order: an
   * `ak_...` key when given (CI, fully headless), otherwise the OAuth token
   * a previous `clerk auth login` stored on this machine. With neither,
   * every call fails as a typed 'auth' error.
   */
  constructor(platformKey: string | undefined, run: Runner = spawnRunner) {
    this.platformKey = platformKey;
    this.run = run;
  }

  private async exec(args: string[]): Promise<string> {
    const { status, stdout, stderr } = await this.run(
      [...args, '--mode', 'agent'],
      this.platformKey ? { CLERK_PLATFORM_API_KEY: this.platformKey } : {},
    );
    if (status === 127) {
      throw new ClerkError(
        'not-installed',
        'Could not run the Clerk CLI. Pier shells out to `npx clerk`; make sure npx works here.',
      );
    }
    if (status !== 0) {
      const detail = parseErrorMessage(stdout) ?? parseErrorMessage(stderr) ?? stderr.trim();
      const auth = /auth_required|Not authenticated|Not logged in/i.test(stdout + stderr);
      throw new ClerkError(auth ? 'auth' : 'api', detail || `clerk ${args[0]} failed (${status})`);
    }
    return stdout;
  }

  /**
   * Agent mode prefixes some JSON outputs with a human progress line
   * ("Pulling config schema from ..."), so parse from the first brace or
   * bracket instead of trusting the whole stream. Verified live.
   */
  private async execJson<T>(args: string[]): Promise<T> {
    const raw = await this.exec(args);
    const start = raw.search(/[[{]/);
    if (start === -1) {
      throw new ClerkError('api', `Unexpected non-JSON output from clerk ${args[0]}`);
    }
    try {
      return JSON.parse(raw.slice(start)) as T;
    } catch {
      throw new ClerkError('api', `Unexpected non-JSON output from clerk ${args[0]}`);
    }
  }

  /**
   * Lists the account's applications. Doubles as the read-only credential
   * check (any auth problem surfaces as a typed 'auth' error) and as the
   * duplicate-name lookup that keeps re-runs idempotent after a partial
   * failure. Each entry has the same shape as `apps create` (verified live).
   */
  async listApps(): Promise<ClerkApp[]> {
    const raw = await this.execJson<RawApp[]>(['apps', 'list', '--json']);
    if (!Array.isArray(raw)) return [];
    return raw.map((r) => toClerkApp(r)).filter((a): a is ClerkApp => a !== undefined);
  }

  async createApp(name: string): Promise<ClerkApp> {
    // Real payload shape (verified live): application_id + instances[],
    // each instance carrying environment_type and publishable_key.
    const raw = await this.execJson<RawApp>(['apps', 'create', name, '--json']);
    const app = toClerkApp(raw, name);
    if (!app) {
      throw new ClerkError('api', 'clerk apps create returned no application id');
    }
    return app;
  }

  /**
   * Top-level property names of the instance config schema (a JSON Schema
   * document: the keys live under `properties`). Used to drop (loudly) any
   * auth-method fragment whose key has drifted, instead of failing the
   * whole patch or, worse, silently configuring nothing.
   */
  async schemaKeys(appId: string): Promise<string[]> {
    const schema = await this.execJson<{ properties?: Record<string, unknown> }>([
      'config',
      'schema',
      '--app',
      appId,
    ]);
    return Object.keys(schema.properties ?? {});
  }

  async pullConfig(appId: string): Promise<Record<string, unknown>> {
    // `config pull` wraps the document as {config_version, config: {...}}.
    const pulled = await this.execJson<{ config?: Record<string, unknown> }>([
      'config',
      'pull',
      '--app',
      appId,
    ]);
    return pulled.config ?? (pulled as Record<string, unknown>);
  }

  async patchConfig(appId: string, patch: Record<string, unknown>): Promise<void> {
    await this.exec(['config', 'patch', '--app', appId, '--json', JSON.stringify(patch), '--yes']);
  }

  /**
   * Pulls the dev-instance keys into an env file (merge, not clobber —
   * the CLI updates Clerk keys in place and preserves everything else).
   * `--app` works from any directory, so the scaffold dir needs no link.
   */
  async envPull(appId: string, file: string): Promise<void> {
    await this.exec(['env', 'pull', '--app', appId, '--file', file]);
  }
}

/**
 * The CLI's agent mode reports failures as `{"error":{"code","message"}}`,
 * sometimes behind the same human progress line that prefixes JSON on the
 * success path — so parse from the first brace, like execJson does.
 */
function parseErrorMessage(raw: string): string | undefined {
  const start = raw.indexOf('{');
  if (start === -1) return undefined;
  try {
    const parsed = JSON.parse(raw.slice(start)) as { error?: { message?: string } };
    return parsed.error?.message;
  } catch {
    return undefined;
  }
}
