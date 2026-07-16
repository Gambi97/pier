import { describe, expect, it } from 'vitest';

import { GhError, GitHubPublisher, type GhResult, type GhRunner } from './github.js';

interface Call {
  args: string[];
  cwd: string;
  input?: string;
}

function fakeGh(respond: (args: string[]) => GhResult): { runner: GhRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: GhRunner = (args, opts) => {
    calls.push({ args, cwd: opts.cwd, input: opts.input });
    return Promise.resolve(respond(args));
  };
  return { runner, calls };
}

const ok = (stdout: string): GhResult => ({ status: 0, stdout, stderr: '' });
const fail = (stderr: string): GhResult => ({ status: 1, stdout: '', stderr });

describe('GitHubPublisher', () => {
  it('creates the private repo with a push and returns its URL', async () => {
    const { runner, calls } = fakeGh((args) =>
      args[0] === 'repo' && args[1] === 'view'
        ? fail('no git remotes found')
        : ok('✓ Created repository me/pizza\nhttps://github.com/me/pizza\n'),
    );
    const url = await new GitHubPublisher(runner).publish('/tmp/app', 'pizza');
    expect(url).toBe('https://github.com/me/pizza');
    const create = calls[1]!;
    expect(create.args).toContain('--private');
    expect(create.args).toContain('--push');
    expect(create.cwd).toBe('/tmp/app');
  });

  it('reuses an already-published repo on re-runs', async () => {
    const { runner, calls } = fakeGh(() => ok('https://github.com/me/pizza\n'));
    const url = await new GitHubPublisher(runner).publish('/tmp/app', 'pizza');
    expect(url).toBe('https://github.com/me/pizza');
    expect(calls).toHaveLength(1); // no create call
  });

  it('sends secrets via stdin, never argv', async () => {
    const { runner, calls } = fakeGh(() => ok(''));
    await new GitHubPublisher(runner).setSecret('/tmp/app', 'SCW_SECRET_KEY', 's3cret');
    const call = calls[0]!;
    expect(call.input).toBe('s3cret');
    expect(call.args.join(' ')).not.toContain('s3cret');
  });

  it('maps a missing gh binary to a guided error', async () => {
    const runner: GhRunner = () => Promise.resolve({ status: 127, stdout: '', stderr: '' });
    await expect(new GitHubPublisher(runner).setVariable('/x', 'A', 'b')).rejects.toThrow(
      /GitHub CLI/,
    );
  });

  it('surfaces the first stderr line of a failure', async () => {
    const { runner } = fakeGh((args) =>
      args[1] === 'view' ? fail('x') : fail('HTTP 403: rate limited\nmore detail'),
    );
    await expect(new GitHubPublisher(runner).publish('/x', 'pizza')).rejects.toThrow(
      new GhError('HTTP 403: rate limited'),
    );
  });
});
