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
}

export class ClerkCli {
  private readonly run: Runner;
  private readonly platformKey: string;

  constructor(platformKey: string, run: Runner = spawnRunner) {
    this.platformKey = platformKey;
    this.run = run;
  }

  private async exec(args: string[]): Promise<string> {
    const { status, stdout, stderr } = await this.run([...args, '--mode', 'agent'], {
      CLERK_PLATFORM_API_KEY: this.platformKey,
    });
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

  private async execJson<T>(args: string[]): Promise<T> {
    const raw = await this.exec(args);
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new ClerkError('api', `Unexpected non-JSON output from clerk ${args[0]}`);
    }
  }

  /** Cheap read-only credential check: lists apps, discards the result. */
  async validateKey(): Promise<void> {
    await this.exec(['apps', 'list', '--json']);
  }

  async createApp(name: string): Promise<ClerkApp> {
    const app = await this.execJson<{
      id?: string;
      name?: string;
      object?: string;
    }>(['apps', 'create', name, '--json']);
    if (!app.id) throw new ClerkError('api', 'clerk apps create returned no application id');
    return { id: app.id, name: app.name ?? name };
  }

  /**
   * Top-level config keys the instance schema knows. Used to drop (loudly)
   * any auth-method fragment whose key has drifted, instead of failing the
   * whole patch or, worse, silently configuring nothing.
   */
  async schemaKeys(): Promise<string[]> {
    const schema = await this.execJson<Record<string, unknown>>(['config', 'schema']);
    return Object.keys(schema);
  }

  async pullConfig(appId: string): Promise<Record<string, unknown>> {
    return this.execJson<Record<string, unknown>>(['config', 'pull', '--app', appId]);
  }

  async patchConfig(appId: string, patch: Record<string, unknown>): Promise<void> {
    await this.exec(['config', 'patch', '--app', appId, '--json', JSON.stringify(patch), '--yes']);
  }
}

/** The CLI's agent mode reports failures as `{"error":{"code","message"}}`. */
function parseErrorMessage(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    return parsed.error?.message;
  } catch {
    return undefined;
  }
}
