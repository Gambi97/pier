import { spawn } from 'node:child_process';

/**
 * Phase D — fill the GitHub repo pier was launched inside, wired for the
 * fleet. Pier never creates the repo: you create and clone the (empty) repo
 * yourself, run pier in it, and pier pushes its scaffold to the existing
 * origin and configures the CI.
 *
 * Everything shells out to `gh`/`git` (already authenticated on the machine
 * that ran keel) and degrades to printed manual commands when it cannot run.
 * Besides pushing the first commit, Phase D configures what the generated CI
 * needs to push images to keel's environment registries: the SCW_SECRET_KEY
 * secret (docker login is `nologin` + secret key, keel's own documented
 * recipe) and the non-sensitive variables. Values come from the same shell
 * environment keel ran in — pier consumes what keel emitted, never the other
 * way around.
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

/** Same shape, spawning `git` — the push shells out to it. */
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
   * Phase 0 check — gh is installed and its stored login still works.
   * A harmless read (the authenticated user) that fails exactly the way
   * Phase D would, while there is still nothing half-configured to orphan.
   * Returns the login for the "connected as" line.
   */
  async verifyAuth(cwd: string): Promise<string> {
    const login = (await this.gh(['api', 'user', '--jq', '.login'], cwd)).trim();
    if (!login) throw new GhError('gh answered without a login — run `gh auth status`.');
    return login;
  }

  /**
   * Phase 0 check — the repo pier was launched inside must already exist on
   * GitHub and resolve from the directory, because pier no longer creates it:
   * it fills, pushes and wires the repo it lives in. Verified up front, while
   * there is still nothing to orphan. Returns the repo URL for the handoff.
   */
  async resolveRepo(dir: string): Promise<string> {
    const url = (await this.gh(['repo', 'view', '--json', 'url', '--jq', '.url'], dir)).trim();
    if (!url) {
      throw new GhError(
        'gh resolved no repo from this directory — create the repo and clone it, then run pier inside it.',
      );
    }
    return url;
  }

  /**
   * Push the scaffold's first commit to the existing origin. The repo was
   * verified reachable in Phase 0; a freshly created, cloned-empty repo has
   * an unborn `main`, so `-u origin HEAD` publishes the branch and sets its
   * tracking. Re-runs push nothing new — normal git flow, idempotent.
   */
  async push(dir: string): Promise<void> {
    const { status, stdout, stderr } = await this.runGit(['push', '-u', 'origin', 'HEAD'], {
      cwd: dir,
    });
    if (status === 127) {
      throw new GhError('git not found — push the repo yourself.');
    }
    if (status !== 0) {
      const firstLine = (stderr || stdout).trim().split('\n')[0];
      throw new GhError(firstLine || `git push failed (${status})`);
    }
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
