import { spawn } from 'node:child_process';

/**
 * Phase D — hand the scaffolded repo over to GitHub, wired for the fleet.
 *
 * Everything shells out to `gh` (already authenticated on the machine that
 * ran keel) and degrades to printed manual commands when it cannot run.
 * Besides creating and pushing the private repo, Phase D configures what
 * the generated CI needs to push images to keel's environment registries:
 * the SCW_SECRET_KEY secret (docker login is `nologin` + secret key, keel's
 * own documented recipe) and the non-sensitive variables. Values come from
 * the same shell environment keel ran in — pier consumes what keel emitted,
 * never the other way around.
 */

export class GhError extends Error {}

export interface GhResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Injectable `gh` runner so tests never touch the network or the CLI. */
export type GhRunner = (args: string[], opts: { cwd: string; input?: string }) => Promise<GhResult>;

const spawnCli =
  (bin: string): GhRunner =>
  (args, opts) =>
    new Promise((resolve) => {
      const child = spawn(bin, args, {
        cwd: opts.cwd,
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', () => resolve({ status: 127, stdout, stderr }));
      child.on('close', (status) => resolve({ status: status ?? 1, stdout, stderr }));
      if (opts.input !== undefined) child.stdin?.end(opts.input);
    });

export const spawnGh: GhRunner = spawnCli('gh');

/** Same shape, spawning `git` — publish uses it to repair a broken remote. */
export const spawnGit: GhRunner = spawnCli('git');

export class GitHubPublisher {
  private readonly run: GhRunner;
  private readonly runGit: GhRunner;

  constructor(run: GhRunner = spawnGh, runGit: GhRunner = spawnGit) {
    this.run = run;
    this.runGit = runGit;
  }

  private async gh(args: string[], cwd: string, input?: string): Promise<string> {
    const { status, stdout, stderr } = await this.run(args, { cwd, input });
    if (status === 127) {
      throw new GhError('GitHub CLI (gh) not found — install it or publish the repo yourself.');
    }
    if (status !== 0) {
      const firstLine = (stderr || stdout).trim().split('\n')[0];
      throw new GhError(firstLine || `gh ${args.join(' ')} failed (${status})`);
    }
    return stdout;
  }

  /**
   * Creates the private repo and pushes; when the directory is already
   * linked to a GitHub repo (re-run) it just reports that repo's URL —
   * pushing day-2 commits is normal git flow, not pier's business.
   */
  async publish(dir: string, name: string): Promise<string> {
    const existing = await this.run(['repo', 'view', '--json', 'url', '--jq', '.url'], {
      cwd: dir,
    });
    if (existing.status === 0 && existing.stdout.trim()) return existing.stdout.trim();
    // gh could not resolve a repo from the directory, so any origin remote
    // sitting there is unusable (a dead or malformed URL from an earlier
    // failed publish) and would make `repo create --remote origin` refuse
    // to attach — drop it and let the create own the remote.
    const origin = await this.runGit(['remote', 'get-url', 'origin'], { cwd: dir });
    if (origin.status === 0) {
      await this.runGit(['remote', 'remove', 'origin'], { cwd: dir });
    }
    const out = await this.gh(
      ['repo', 'create', name, '--private', '--source', '.', '--remote', 'origin', '--push'],
      dir,
    );
    return /https:\/\/github\.com\/\S+/.exec(out)?.[0] ?? name;
  }

  /** Plain Actions variable (non-sensitive wiring, keel's own split). */
  async setVariable(dir: string, name: string, value: string): Promise<void> {
    await this.gh(['variable', 'set', name, '--body', value], dir);
  }

  /** Encrypted Actions secret; the value travels via stdin, never argv. */
  async setSecret(dir: string, name: string, value: string): Promise<void> {
    await this.gh(['secret', 'set', name], dir, value);
  }
}
