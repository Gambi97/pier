#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import * as p from '@clack/prompts';

import { ClerkCli, ClerkError, type ClerkApp } from './clerk.js';
import { GhError, GitHubPublisher } from './github.js';
import {
  ConfigError,
  validateMethods,
  validatePlatformKey,
  validateProjectName,
} from './config.js';
import {
  CLERK_SECRET_NAMES,
  INFISICAL_DEFAULT_HOST,
  InfisicalClient,
  InfisicalError,
  type InfisicalCoordinates,
  PROD_SLUG,
  buildSecretPlan,
  extractClerkKeys,
  readInfisicalCoordinates,
} from './infisical.js';
import { AUTH_METHODS, buildPatch, methodLabel, type AuthMethod } from './methods.js';
import {
  detectExistingScaffold,
  ensureEmptyTarget,
  initGitRepo,
  planScaffold,
  writeScaffold,
} from './scaffold.js';

const HELP = `pier — the gangway your users board through

Usage: npx github:Gambi97/pier [options]

Options:
  --name <project>      Fleet project name (Clerk application and app repo take it)
  --methods <list>      Comma-separated: ${AUTH_METHODS.join(', ')}
  --dir <path>          Where to scaffold the app repo (default: ./<project>)
  --owner <login>       GitHub owner (organization or user) for the created repo
                        (default: the account gh is logged in as)
  --skip-github         Do not create/push the GitHub repo (Phase D)
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
  SCW_SECRET_KEY / SCW_REGION
                           Optional (same shell keel ran in): lets Phase D give the
                           app repo its image-push credential and wiring.

Order (keel's principle — verify every link first, create last): pier first
verifies the Infisical link (asking for missing credentials instead of
skipping) and reads the keel project's environments, then checks the Clerk
credential, and only then creates: the Clerk application with the chosen auth
methods, the keys pushed to keel's Infisical project (dev keys to non-prod
environments, placeholders to prod, never overwriting), and the DDD-layered
Next.js app repo with a gitignored .env.local, git-inited. Pier is not a
dependency of the generated repo.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      methods: { type: 'string' },
      dir: { type: 'string' },
      owner: { type: 'string' },
      'skip-github': { type: 'boolean', default: false },
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
        ? 'Would push the Clerk keys to the keel Infisical project: every non-prod ' +
            'environment gets the Clerk development-instance keys (one shared user ' +
            'pool), prod gets placeholders for its own production instance.'
        : 'Infisical push would be skipped (INFISICAL_CLIENT_ID/SECRET not set).',
    );
    const files = Object.keys(planScaffold(projectName));
    p.log.info(
      `Would then scaffold the app repo (${files.length} files) into ${targetDir}, ` +
        'pull the dev keys into its gitignored .env.local, git-init it, and ' +
        (values['skip-github']
          ? 'stop there (--skip-github).'
          : 'publish it to GitHub with its image-push CI wiring.'),
    );
    p.outro('Nothing was called.');
    return;
  }

  // A previous pier run of the same project is welcome (idempotent re-run,
  // e.g. after keel's first apply materialized APP_URL); anything else in
  // the way fails before Clerk is touched.
  const existingScaffold = await detectExistingScaffold(targetDir, projectName);
  if (!existingScaffold) await ensureEmptyTarget(targetDir);

  const spin = p.spinner();

  // Phase 0 — keel's principle: verify every credential and link up front,
  // create nothing until all of them are confirmed. Infisical comes first
  // because keel already provisioned the project — its environments tell
  // pier what the fleet looks like before anything is created on Clerk,
  // and a bad link stops the run while there is still nothing to orphan.
  let infisicalClient: InfisicalClient | undefined;
  let infisicalProject: { id: string; environments: string[] } | undefined;

  if (infisical && nonInteractive) {
    // --yes: verify once and fail hard — CI has nobody to re-ask.
    const coords = infisical;
    try {
      infisicalClient = new InfisicalClient(coords);
      infisicalProject = await step(
        spin,
        'Verifying the Infisical link',
        (proj) =>
          `Infisical connected — project "${projectName}" (${proj.id}), ` +
          `environments: ${proj.environments.join(', ') || '(none)'}`,
        () => infisicalClient!.resolveProject(projectName),
      );
    } catch (error) {
      if (!(error instanceof InfisicalError)) throw error;
      p.log.error(
        `Infisical verification failed (${error.message}). Nothing was created — ` +
          'fix the credentials (or run keel first) and re-run pier.',
      );
      process.exit(1);
    }
  } else if (!nonInteractive) {
    let wants = infisical !== undefined;
    if (!wants) {
      const answer = await p.confirm({
        message:
          'No Infisical credentials in this shell. Enter the keel machine identity now? ' +
          '(No = keys stay only in the local .env.local)',
      });
      bailOnCancel(answer);
      wants = answer === true;
    }
    if (wants) {
      // keel's own credential block, same structure and copy: host first,
      // then the machine identity, verified in a loop that re-asks exactly
      // what failed instead of bailing out of the run.
      const coords: InfisicalCoordinates = infisical ?? {
        host: '',
        clientId: '',
        clientSecret: '',
        projectId: process.env.INFISICAL_PROJECT_ID?.trim() || undefined,
      };
      // An env-defaulted host was never chosen — ask it like keel does; an
      // explicit INFISICAL_HOST is respected.
      if (!process.env.INFISICAL_HOST?.trim()) coords.host = '';
      for (;;) {
        if (!coords.host) coords.host = await askInfisicalHost();
        if (!coords.clientId) {
          coords.clientId = (await askText('Infisical machine identity client ID')).trim();
        }
        if (!coords.clientSecret) {
          coords.clientSecret = (
            await askSecret('Infisical machine identity client secret')
          ).trim();
        }
        try {
          const client = new InfisicalClient(coords);
          infisicalProject = await step(
            spin,
            'Verifying the Infisical link',
            (proj) =>
              `Infisical connected — project "${projectName}" (${proj.id}), ` +
              `environments: ${proj.environments.join(', ') || '(none)'}`,
            () => client.resolveProject(projectName),
          );
          infisicalClient = client;
          break;
        } catch (error) {
          if (!(error instanceof InfisicalError)) throw error;
          p.log.error(error.message);
          if (error.field === 'project') {
            const id = (
              await askText('Infisical project ID to reuse (leave empty to abort)')
            ).trim();
            if (!id) {
              p.cancel('No Infisical project — run keel first, then re-run pier.');
              process.exit(1);
            }
            coords.projectId = id;
          } else {
            coords.clientId = '';
            coords.clientSecret = '';
          }
        }
      }
    }
  }

  const platformKey = validatePlatformKey(process.env.CLERK_PLATFORM_API_KEY);

  const clerk = new ClerkCli(platformKey);

  let apps: ClerkApp[];
  try {
    apps = await step(
      spin,
      platformKey ? 'Validating the platform key' : 'Checking the stored Clerk login',
      'Clerk credential OK',
      () => clerk.listApps(),
    );
  } catch (error) {
    if (!(error instanceof ClerkError) || error.code !== 'auth') throw error;

    // A rejected platform key is a bad key, not a missing login — logging in
    // wouldn't help it; and a non-interactive run (CI) has no browser to log
    // in with. Both stay a hard error with the manual path.
    if (platformKey || nonInteractive) {
      p.log.error(
        platformKey
          ? 'The CLERK_PLATFORM_API_KEY was rejected — check the key (ak_...).'
          : 'No Clerk credential found. Export CLERK_PLATFORM_API_KEY (ak_...) or run ' +
              '`npx clerk auth login`, then re-run pier.',
      );
      process.exit(1);
    }

    // Interactive and no stored login: do what keel does — log in inline and
    // carry on in the same run, rather than making the operator start over.
    const proceed = await p.confirm({
      message: 'No Clerk login found. Log in now? (opens your browser)',
    });
    bailOnCancel(proceed);
    if (!proceed) {
      p.cancel('A Clerk login is required. Run `npx clerk auth login`, then re-run pier.');
      process.exit(1);
    }
    await clerk.login();
    apps = await step(spin, 'Re-checking the Clerk login', 'Clerk credential OK', () =>
      clerk.listApps(),
    );
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

  if (existingScaffold) {
    p.log.info(`Existing pier scaffold found in ${targetDir} — files left untouched.`);
  } else {
    const files = planScaffold(projectName);
    await step(
      spin,
      `Scaffolding the app repo in ${targetDir}`,
      `App repo scaffolded (${Object.keys(files).length} files)`,
      () => writeScaffold(targetDir, files),
    );
  }

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
  // .env.local is only the local-dev convenience copy. The link and the
  // project were verified in Phase 0 — this only pushes. Along the way, pick
  // up the APP_URL keel's pipeline synced for each non-prod environment.
  // Known since Phase 0 — the CI wiring gets them even when the push fails.
  const nonProdEnvs = infisicalProject?.environments.filter((slug) => slug !== PROD_SLUG);
  let appUrls: string[] = [];
  if (!infisicalClient || !infisicalProject) {
    p.log.info(
      'Infisical push skipped — no keel machine identity was given, so the Clerk keys ' +
        'live only in the local .env.local. Re-run pier with the credentials to store them.',
    );
  } else if (!keysPulled) {
    p.log.warn('Skipping the Infisical push: the Clerk keys were not pulled (see above).');
  } else {
    const client = infisicalClient;
    const project = infisicalProject;
    try {
      const result = await step(
        spin,
        `Pushing the Clerk keys to Infisical (project ${project.id})`,
        (r: { created: number; kept: number }) =>
          `Clerk keys in Infisical project ${project.id} ` +
          `(${r.created} created, ${r.kept} already set and kept)`,
        async () => {
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
          const urls: string[] = [];
          for (const env of nonProdEnvs ?? []) {
            const url = await client.getSecret(project.id, env, 'APP_URL');
            if (url && /^https?:\/\//.test(url)) urls.push(url);
          }
          return { created, kept, urls };
        },
      );
      appUrls = result.urls;
      // The keel↔Clerk asymmetry must be said out loud, not discovered:
      // keel has N environments, Clerk has two instances.
      p.log.info(
        `Environment map: ${(nonProdEnvs ?? []).join(', ') || '(none)'} → Clerk development instance ` +
          `(one shared user pool); prod → production instance (placeholders until you ` +
          'set up its Google OAuth client + DNS and replace them in Infisical).',
      );
    } catch (error) {
      if (!(error instanceof InfisicalError)) throw error;
      p.log.warn(
        `Could not push the keys to Infisical (${error.message}). Everything else is done — ` +
          'fix the coordinates and re-run pier (the push never overwrites existing secrets).',
      );
    }
  }

  // Phase A′ — the deployed keel URLs must be allowed origins on the dev
  // instance before its keys work from them. APP_URL is real only after
  // keel's first apply; until then this re-runs cleanly later.
  if (appUrls.length > 0) {
    try {
      const origins = [...new Set(['http://localhost:3000', ...appUrls])];
      await step(
        spin,
        'Setting Clerk allowed origins',
        `Allowed origins: ${origins.join(', ')}`,
        () => clerk.setAllowedOrigins(app.id, origins),
      );
    } catch (error) {
      if (!(error instanceof ClerkError)) throw error;
      p.log.warn(`Could not set the allowed origins (${error.message}) — re-run pier to retry.`);
    }
  } else {
    p.log.info(
      'No APP_URL in Infisical yet (keel not applied, or push skipped): allowed origins ' +
        'unchanged. Re-run pier after the first keel apply to register the deployed URLs.',
    );
  }

  let gitReady = existingScaffold;
  if (!existingScaffold) {
    gitReady = await initGitRepo(targetDir);
    if (gitReady) {
      p.log.info('Git repository initialized with a first commit.');
    } else {
      p.log.warn('Could not git-init the repo (no git, or no git identity) — commit it yourself.');
    }
  }

  // Phase D — hand the repo over to GitHub and wire its image-push CI.
  if (values['skip-github']) {
    p.log.info('GitHub publish skipped (--skip-github).');
  } else if (!gitReady) {
    p.log.warn('Skipping the GitHub publish: the repo has no commit yet.');
  } else {
    // gh resolves a bare name to the logged-in user; --owner routes the
    // repo into an organization instead.
    const repoSlug = values.owner ? `${values.owner}/${projectName}` : projectName;
    try {
      const publisher = new GitHubPublisher();
      const repoUrl = await step(
        spin,
        'Publishing to GitHub (private repo)',
        (url) => `On GitHub: ${url}`,
        () => publisher.publish(targetDir, repoSlug),
      );
      void repoUrl;
      const region = process.env.SCW_REGION?.trim() || 'fr-par';
      await publisher.setVariable(targetDir, 'SCW_REGION', region);
      await publisher.setVariable(targetDir, 'PROJECT_NAME', projectName);
      if (nonProdEnvs && nonProdEnvs.length > 0) {
        await publisher.setVariable(targetDir, 'KEEL_NON_PROD_ENVIRONMENTS', nonProdEnvs.join(' '));
      }
      const scwSecretKey = process.env.SCW_SECRET_KEY?.trim();
      if (scwSecretKey) {
        await publisher.setSecret(targetDir, 'SCW_SECRET_KEY', scwSecretKey);
        p.log.info('Image-push CI configured (SCW_SECRET_KEY secret + registry variables).');
      } else {
        p.log.warn(
          'SCW_SECRET_KEY not in this shell — CI will build the image but skip the registry ' +
            `push until you run: gh secret set SCW_SECRET_KEY (in ${targetDir}).`,
        );
      }
    } catch (error) {
      if (!(error instanceof GhError)) throw error;
      p.log.warn(
        `GitHub publish incomplete (${error.message}). Manual path: ` +
          `cd ${targetDir} && gh repo create ${repoSlug} --private --source . --push`,
      );
    }
  }

  p.outro(
    `Done. Your app repo is ready:\n` +
      `  cd ${targetDir} && npm install && npm run dev\n` +
      'Deploy: merge to main pushes the image; set container_image in the keel tfvars.',
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
    // clack v1: dedicated error state instead of stop(message, code).
    spin.error(`${start} — failed`);
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

/** Like askText, but masked — for credentials that must not echo. */
async function askSecret(message: string): Promise<string> {
  const answer = await p.password({ message });
  bailOnCancel(answer);
  return answer as string;
}

/** Host selector, keel's own structure and copy — the credentials only
 * authenticate on the host keel was bootstrapped against. */
async function askInfisicalHost(): Promise<string> {
  const choice = await p.select({
    message: 'Infisical host',
    initialValue: 'us',
    options: [
      { value: 'us', label: 'US — app.infisical.com', hint: 'default' },
      { value: 'eu', label: 'EU — eu.infisical.com' },
      { value: 'other', label: 'Other (self-hosted)' },
    ],
  });
  bailOnCancel(choice);
  if (choice === 'us') return INFISICAL_DEFAULT_HOST;
  if (choice === 'eu') return 'https://eu.infisical.com';
  return (await askText('Infisical host URL')).trim();
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
