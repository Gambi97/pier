#!/usr/bin/env node
import { parseArgs } from 'node:util';

import * as p from '@clack/prompts';

import { ClerkCli, ClerkError } from './clerk.js';
import {
  ConfigError,
  validateMethods,
  validatePlatformKey,
  validateProjectName,
} from './config.js';
import { AUTH_METHODS, buildPatch, methodLabel, type AuthMethod } from './methods.js';

const HELP = `pier — the gangway your users board through

Usage: npx pier [options]

Options:
  --name <project>      Fleet project name (the Clerk application takes it)
  --methods <list>      Comma-separated: ${AUTH_METHODS.join(', ')}
  --dry-run             Show what would happen without calling Clerk
  --yes                 Accept defaults, fail instead of prompting
  -h, --help            Show this help

Environment:
  CLERK_PLATFORM_API_KEY   Platform API key (ak_...), the only credential Pier needs.

Phase A only for now: creates the Clerk application and enables the chosen
auth methods. Secrets push (Infisical) and the Next.js scaffold are next.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      methods: { type: 'string' },
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

  if (values['dry-run']) {
    p.log.info(`Dry run — would create Clerk app "${projectName}" and enable:`);
    for (const m of methods) p.log.message(`  - ${methodLabel(m)}`);
    p.outro('Nothing was called.');
    return;
  }

  const platformKey = validatePlatformKey(
    process.env.CLERK_PLATFORM_API_KEY ??
      (nonInteractive
        ? missing('CLERK_PLATFORM_API_KEY')
        : await askSecret('Clerk platform API key (ak_...)')),
  );

  const clerk = new ClerkCli(platformKey);
  const spin = p.spinner();

  spin.start('Validating the platform key');
  await clerk.validateKey();
  spin.stop('Platform key OK');

  spin.start(`Creating Clerk application "${projectName}"`);
  const app = await clerk.createApp(projectName);
  spin.stop(`Application created (${app.id})`);

  spin.start('Reading the instance config schema');
  const schemaKeys = await clerk.schemaKeys();
  const plan = buildPatch(methods, schemaKeys);
  spin.stop('Schema read');

  for (const droppedMethod of plan.dropped) {
    p.log.warn(
      `Skipping "${droppedMethod}": the live config schema has no matching key — ` +
        'the Clerk schema may have changed; enable it in the dashboard and open a Pier issue.',
    );
  }

  if (Object.keys(plan.patch).length > 0) {
    spin.start('Enabling auth methods');
    await clerk.patchConfig(app.id, plan.patch);
    spin.stop('Auth methods enabled');
  }

  p.outro(
    `Done. App ${app.id} is configured for: ${methods
      .filter((m) => !plan.dropped.includes(m))
      .join(', ')}. Next up (not built yet): Infisical secrets + Next.js scaffold.`,
  );
}

function missing(what: string): never {
  throw new ConfigError(`--yes given but ${what} is missing.`);
}

async function askText(message: string): Promise<string> {
  const answer = await p.text({ message });
  bailOnCancel(answer);
  return answer as string;
}

async function askSecret(message: string): Promise<string> {
  const answer = await p.password({ message });
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
  if (error instanceof ConfigError || error instanceof ClerkError) {
    p.log.error(error.message);
    process.exit(1);
  }
  throw error;
});
