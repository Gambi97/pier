#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import * as p from '@clack/prompts';

import { ClerkCli, ClerkError, type ClerkApp } from './clerk.js';
import {
  ConfigError,
  validateMethods,
  validatePlatformKey,
  validateProjectName,
} from './config.js';
import {
  CLERK_SECRET_NAMES,
  InfisicalClient,
  InfisicalError,
  buildSecretPlan,
  extractClerkKeys,
  readInfisicalCoordinates,
} from './infisical.js';
import { AUTH_METHODS, buildPatch, methodLabel, type AuthMethod } from './methods.js';
import { ensureEmptyTarget, initGitRepo, planScaffold, writeScaffold } from './scaffold.js';

const HELP = `pier — the gangway your users board through

Usage: npx github:Gambi97/pier [options]

Options:
  --name <project>      Fleet project name (Clerk application and app repo take it)
  --methods <list>      Comma-separated: ${AUTH_METHODS.join(', ')}
  --dir <path>          Where to scaffold the app repo (default: ./<project>)
  --dry-run             Show what would happen without calling Clerk
  --yes                 Accept defaults, fail instead of prompting
  -h, --help            Show this help

Credentials:
  CLERK_PLATFORM_API_KEY   Platform API key (ak_...) — fully headless, right for CI.
  clerk auth login         One-time browser OAuth; Pier then uses the stored token.
  INFISICAL_CLIENT_ID / INFISICAL_CLIENT_SECRET
                           keel's machine identity — enables the secrets push.
  INFISICAL_PROJECT_ID / INFISICAL_HOST
                           Optional; default is find-by-name on app.infisical.com.

Phases A + B + C: creates the Clerk application, enables the chosen auth
methods, pushes the keys to the Infisical project keel provisioned (dev
keys to non-prod environments, placeholders to prod, never overwriting),
scaffolds the DDD-layered Next.js app repo with a gitignored .env.local,
and git-inits it. Pier is not a dependency of the generated repo.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      methods: { type: 'string' },
      dir: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    p.log.message(HELP);
    return;
  }

  p.intro('pier — auth boarding for the keel fleet');

  const nonInteractive = values.yes === true;
  const projectName = validateProjectName(
    values.name ??
      (nonInteractive ? missing('--name') : await askText('Project name (same as keel)')),
  );
  const methods = validateMethods(
    (
      values.methods ??
      (nonInteractive ? 'google,password,magic-link,email-otp' : await askMethods())
    ).split(','),
  );

  const targetDir = resolve(values.dir ?? projectName);
  const infisical = readInfisicalCoordinates(process.env);

  if (values['dry-run']) {
    p.log.info(`Dry run — would create Clerk app "${projectName}" and enable:`);
    for (const m of methods) p.log.message(`  - ${methodLabel(m)}`);
    p.log.info(
      infisical
        ? 'Would push the Clerk keys to the keel Infisical project ' +
            '(dev keys to non-prod environments, placeholders to prod).'
        : 'Infisical push would be skipped (INFISICAL_CLIENT_ID/SECRET not set).',
    );
    const files = Object.keys(planScaffold(projectName));
    p.log.info(
      `Would then scaffold the app repo (${files.length} files) into ${targetDir}, ` +
        'pull the dev keys into its gitignored .env.local, and git-init it.',
    );
    p.outro('Nothing was called.');
    return;
  }

  // Fail on a dirty target before anything is created on Clerk's side.
  await ensureEmptyTarget(targetDir);

  const platformKey = validatePlatformKey(process.env.CLERK_PLATFORM_API_KEY);

  const clerk = new ClerkCli(platformKey);
  const spin = p.spinner();

  let apps: ClerkApp[];
  try {
    apps = await step(
      spin,
      platformKey ? 'Validating the platform key' : 'Checking the stored Clerk login',
      'Clerk credential OK',
      () => clerk.listApps(),
    );
  } catch (error) {
    if (error instanceof ClerkError && error.code === 'auth') {
      p.log.error(
        'No Clerk credential found. Either export CLERK_PLATFORM_API_KEY (ak_...) ' +
          'or run `npx clerk auth login` once, then re-run pier.',
      );
      process.exit(1);
    }
    throw error;
  }

  // Reuse an existing app with the fleet name instead of creating a
  // duplicate — makes a re-run after a partial failure idempotent.
  const existing = apps.find((a) => a.name === projectName);
  if (existing) {
    p.log.info(`Clerk application "${projectName}" already exists (${existing.id}) — reusing it.`);
  }
  const app =
    existing ??
    (await step(
      spin,
      `Creating Clerk application "${projectName}"`,
      (created) => `Application created (${created.id})`,
      () => clerk.createApp(projectName),
    ));

  const schemaKeys = await step(spin, 'Reading the instance config schema', 'Schema read', () =>
    clerk.schemaKeys(app.id),
  );
  const plan = buildPatch(methods, schemaKeys);

  for (const droppedMethod of plan.dropped) {
    p.log.warn(
      `Skipping "${droppedMethod}": the live config schema has no matching key — ` +
        'the Clerk schema may have changed; enable it in the dashboard and open a Pier issue.',
    );
  }
  for (const warning of plan.warnings) p.log.warn(warning);

  if (Object.keys(plan.patch).length > 0) {
    await step(spin, 'Enabling auth methods', 'Auth methods enabled', () =>
      clerk.patchConfig(app.id, plan.patch),
    );
  }

  const enabled = methods.filter((m) => !plan.dropped.includes(m));
  if (enabled.length > 0) {
    p.log.success(`App ${app.id} is configured for: ${enabled.join(', ')}.`);
  } else {
    p.log.warn(`App ${app.id} is ready, but no auth method could be applied — see above.`);
  }

  const files = planScaffold(projectName);
  await step(
    spin,
    `Scaffolding the app repo in ${targetDir}`,
    `App repo scaffolded (${Object.keys(files).length} files)`,
    () => writeScaffold(targetDir, files),
  );

  const envLocal = join(targetDir, '.env.local');
  let keysPulled = true;
  try {
    await step(spin, 'Pulling Clerk keys into .env.local', 'Keys in .env.local (gitignored)', () =>
      clerk.envPull(app.id, envLocal),
    );
  } catch (error) {
    if (!(error instanceof ClerkError)) throw error;
    keysPulled = false;
    p.log.warn(
      `Could not pull the Clerk keys (${error.message}). The scaffold is complete — ` +
        `run \`npx clerk env pull --app ${app.id} --file ${envLocal}\` yourself.`,
    );
  }

  // Phase B — the keys' real home is the Infisical project keel provisioned;
  // .env.local is only the local-dev convenience copy.
  if (!infisical) {
    p.log.info(
      'Infisical push skipped — export INFISICAL_CLIENT_ID / INFISICAL_CLIENT_SECRET ' +
        '(the keel machine identity) to store the keys in the fleet secret store.',
    );
  } else if (!keysPulled) {
    p.log.warn('Skipping the Infisical push: the Clerk keys were not pulled (see above).');
  } else {
    try {
      await step(
        spin,
        'Pushing the Clerk keys to Infisical',
        (r: { created: number; kept: number }) =>
          `Clerk keys in Infisical (${r.created} created, ${r.kept} already set and kept)`,
        async () => {
          const client = new InfisicalClient(infisical);
          const project = await client.resolveProject(projectName);
          const clerkKeys = extractClerkKeys(await readFile(envLocal, 'utf8'));
          const missing = CLERK_SECRET_NAMES.filter((n) => !clerkKeys[n]);
          if (missing.length > 0) {
            throw new InfisicalError(`.env.local is missing ${missing.join(', ')}.`);
          }
          let created = 0;
          let kept = 0;
          for (const push of buildSecretPlan(project.environments, clerkKeys)) {
            if ((await client.pushSecret(project.id, push)) === 'created') created += 1;
            else kept += 1;
          }
          return { created, kept };
        },
      );
    } catch (error) {
      if (!(error instanceof InfisicalError)) throw error;
      p.log.warn(
        `Could not push the keys to Infisical (${error.message}). Everything else is done — ` +
          'fix the coordinates and re-run pier (the push never overwrites existing secrets).',
      );
    }
  }

  if (await initGitRepo(targetDir)) {
    p.log.info('Git repository initialized with a first commit.');
  } else {
    p.log.warn('Could not git-init the repo (no git, or no git identity) — commit it yourself.');
  }

  p.outro(
    `Done. Your app repo is ready:\n` +
      `  cd ${targetDir} && npm install && npm run dev\n` +
      'Next up (not built yet): GitHub handoff.',
  );
}

/** Run one unit of work behind the spinner, stopping it on failure too. */
async function step<T>(
  spin: ReturnType<typeof p.spinner>,
  start: string,
  done: string | ((result: T) => string),
  fn: () => Promise<T>,
): Promise<T> {
  spin.start(start);
  try {
    const result = await fn();
    spin.stop(typeof done === 'function' ? done(result) : done);
    return result;
  } catch (error) {
    spin.stop(`${start} — failed`, 1);
    throw error;
  }
}

function missing(what: string): never {
  throw new ConfigError(`--yes given but ${what} is missing.`);
}

async function askText(message: string): Promise<string> {
  const answer = await p.text({ message });
  bailOnCancel(answer);
  return answer as string;
}

async function askMethods(): Promise<string> {
  const answer = await p.multiselect({
    message: 'Auth methods to enable',
    options: AUTH_METHODS.map((m) => ({ value: m, label: methodLabel(m) })),
    initialValues: [...AUTH_METHODS] as AuthMethod[],
  });
  bailOnCancel(answer);
  return (answer as AuthMethod[]).join(',');
}

function bailOnCancel(answer: unknown): void {
  if (p.isCancel(answer)) {
    p.cancel('Cancelled.');
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  if (
    error instanceof ConfigError ||
    error instanceof ClerkError ||
    error instanceof InfisicalError
  ) {
    p.log.error(error.message);
    process.exit(1);
  }
  throw error;
});
