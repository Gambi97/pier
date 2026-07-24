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
  it('resolveRepo returns the URL of the repo pier runs in', async () => {
    const { runner, calls } = fakeGh(() => ok('https://github.com/me/pizza\n'));
    const url = await new GitHubPublisher(runner).resolveRepo('/tmp/app');
    expect(url).toBe('https://github.com/me/pizza');
    expect(calls[0]!.args).toEqual(['repo', 'view', '--json', 'url', '--jq', '.url']);
    expect(calls[0]!.cwd).toBe('/tmp/app');
  });

  it('resolveRepo maps an unresolvable directory to a guided GhError', async () => {
    const { runner } = fakeGh(() => fail('no git remotes found'));
    await expect(new GitHubPublisher(runner).resolveRepo('/tmp/app')).rejects.toThrow(
      new GhError('no git remotes found'),
    );
    // An empty (but successful) answer is a repo pier cannot push to either.
    const { runner: blank } = fakeGh(() => ok('\n'));
    await expect(new GitHubPublisher(blank).resolveRepo('/tmp/app')).rejects.toThrow(
      /create the repo and clone it/,
    );
  });

  it('push publishes the current branch to the existing origin', async () => {
    const { runner } = fakeGh(() => ok(''));
    const gitCalls: Call[] = [];
    const git: GhRunner = (args, opts) => {
      gitCalls.push({ args, cwd: opts.cwd });
      return Promise.resolve(ok(''));
    };
    await new GitHubPublisher(runner, git).push('/tmp/app');
    expect(gitCalls).toEqual([{ args: ['push', '-u', 'origin', 'HEAD'], cwd: '/tmp/app' }]);
  });

  it('push maps a git failure to the first stderr line', async () => {
    const git: GhRunner = () =>
      Promise.resolve(fail('! [rejected] main -> main (fetch first)\nmore detail'));
    await expect(
      new GitHubPublisher(() => Promise.resolve(ok('')), git).push('/x'),
    ).rejects.toThrow(new GhError('! [rejected] main -> main (fetch first)'));
  });

  it('push maps a missing git binary to a guided error', async () => {
    const git: GhRunner = () => Promise.resolve({ status: 127, stdout: '', stderr: '' });
    await expect(
      new GitHubPublisher(() => Promise.resolve(ok('')), git).push('/x'),
    ).rejects.toThrow(/git not found/);
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

  it('verifyAuth returns the logged-in account', async () => {
    const { runner, calls } = fakeGh(() => ok('gambi97\n'));
    await expect(new GitHubPublisher(runner).verifyAuth('/tmp')).resolves.toBe('gambi97');
    expect(calls[0]!.args).toEqual(['api', 'user', '--jq', '.login']);
  });

  it('verifyAuth maps a dead login to a GhError', async () => {
    const { runner } = fakeGh(() => fail('HTTP 401: Bad credentials'));
    await expect(new GitHubPublisher(runner).verifyAuth('/tmp')).rejects.toThrow(
      new GhError('HTTP 401: Bad credentials'),
    );
  });

  it('surfaces the first stderr line of a gh failure', async () => {
    const { runner } = fakeGh(() => fail('HTTP 403: rate limited\nmore detail'));
    await expect(new GitHubPublisher(runner).setVariable('/x', 'A', 'b')).rejects.toThrow(
      new GhError('HTTP 403: rate limited'),
    );
  });
});
