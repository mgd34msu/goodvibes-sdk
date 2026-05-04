import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { DEFAULT_DO_NAMESPACE_NAME } from './constants.js';
import type {
  CloudflareApiClient,
  CloudflareDurableObjectNamespaceLike,
  CloudflareProvisionStep,
  CloudflareWorkerScriptLike,
} from './types.js';
import { clean, collectAsync } from './utils.js';
import { GOODVIBES_CLOUDFLARE_WORKER_MODULE } from './worker-source.js';
import type { CloudflareProvisioningContext } from './resources.js';

const GOODVIBES_DO_MIGRATION_TAG = 'goodvibes-coordinator-v1';

type WorkerMigrationMetadata = {
  readonly new_tag?: string | undefined;
  readonly old_tag?: string | undefined;
  readonly steps: readonly { readonly new_sqlite_classes: readonly string[] }[];
};

export interface WorkerUploadResult {
  readonly durableObjectMigration:
    | 'disabled'
    | 'create-sqlite-class'
    | 'current'
    | 'existing-namespace'
    | 'recovered-existing-class';
  readonly migrationTag?: string | undefined;
  readonly namespaceId?: string | undefined;
}

export function describeWorkerUploadDurableObjectMigration(upload: WorkerUploadResult): string {
  switch (upload.durableObjectMigration) {
    case 'create-sqlite-class':
      return 'Applied Durable Object SQLite class migration for GoodVibesCoordinator.';
    case 'current':
      return `Durable Object migration ${upload.migrationTag ?? GOODVIBES_DO_MIGRATION_TAG} is already current.`;
    case 'existing-namespace':
      return 'Using existing Durable Object namespace for GoodVibesCoordinator; no new class migration was applied.';
    case 'recovered-existing-class':
      return 'Cloudflare reported GoodVibesCoordinator already exists; retried Worker upload without reapplying the new class migration.';
    case 'disabled':
      return 'Durable Object migration was skipped because Durable Objects are disabled.';
  }
}

export async function uploadWorker(
  client: CloudflareApiClient,
  input: {
    readonly accountId: string;
    readonly workerName: string;
    readonly queueName: string;
    readonly daemonBaseUrl: string;
    readonly queueJobPayloads: boolean;
    readonly kvNamespaceId: string;
    readonly r2BucketName: string;
    readonly durableObject: boolean;
  },
): Promise<WorkerUploadResult> {
  const file = new File(
    [GOODVIBES_CLOUDFLARE_WORKER_MODULE],
    'goodvibes-cloudflare-worker.mjs',
    { type: 'application/javascript+module' },
  );
  const bindings: Record<string, unknown>[] = [
    ...(input.queueName ? [{ type: 'queue', name: 'GOODVIBES_BATCH_QUEUE', queue_name: input.queueName }] : []),
    { type: 'plain_text', name: 'GOODVIBES_DAEMON_URL', text: input.daemonBaseUrl },
    { type: 'plain_text', name: 'GOODVIBES_QUEUE_JOB_PAYLOADS', text: input.queueJobPayloads ? 'true' : 'false' },
    ...(input.kvNamespaceId ? [{ type: 'kv_namespace', name: 'GOODVIBES_KV', namespace_id: input.kvNamespaceId }] : []),
    ...(input.r2BucketName ? [{ type: 'r2_bucket', name: 'GOODVIBES_ARTIFACTS', bucket_name: input.r2BucketName }] : []),
    ...(input.durableObject ? [{ type: 'durable_object_namespace', name: 'GOODVIBES_COORDINATOR', class_name: DEFAULT_DO_NAMESPACE_NAME }] : []),
  ];
  const migrationPlan = await resolveDurableObjectMigration(client, input.accountId, input.workerName, input.durableObject);
  const metadata = buildWorkerMetadata(bindings, migrationPlan.migrations);
  try {
    await client.workers.scripts.update(input.workerName, {
      account_id: input.accountId,
      metadata,
      files: [file],
    });
    return migrationPlan.result;
  } catch (error: unknown) {
    if (!migrationPlan.migrations || !isDurableObjectAlreadyMigratedError(error)) throw error;
    await client.workers.scripts.update(input.workerName, {
      account_id: input.accountId,
      metadata: buildWorkerMetadata(bindings, undefined),
      files: [file],
    });
    return {
      durableObjectMigration: 'recovered-existing-class',
      migrationTag: GOODVIBES_DO_MIGRATION_TAG,
    };
  }
}

function buildWorkerMetadata(
  bindings: readonly Record<string, unknown>[],
  migrations: WorkerMigrationMetadata | undefined,
): Record<string, unknown> {
  return {
    main_module: 'goodvibes-cloudflare-worker.mjs',
    compatibility_date: '2026-04-25',
    bindings,
    ...(migrations ? { migrations } : {}),
    keep_bindings: ['secret_text'],
  };
}

async function resolveDurableObjectMigration(
  client: CloudflareApiClient,
  accountId: string,
  workerName: string,
  enabled: boolean,
): Promise<{
  readonly migrations?: WorkerMigrationMetadata | undefined;
  readonly result: WorkerUploadResult;
}> {
  if (!enabled) {
    return { result: { durableObjectMigration: 'disabled' } };
  }

  const currentTag = await readWorkerMigrationTag(client, accountId, workerName);
  if (currentTag === GOODVIBES_DO_MIGRATION_TAG) {
    return { result: { durableObjectMigration: 'current', migrationTag: currentTag } };
  }

  const existingNamespace = await findExistingDurableObjectNamespace(client, accountId, workerName);
  if (existingNamespace) {
    return {
      result: {
        durableObjectMigration: 'existing-namespace',
        ...(currentTag ? { migrationTag: currentTag } : {}),
        ...(existingNamespace.id ? { namespaceId: existingNamespace.id } : {}),
      },
    };
  }

  const migrations: WorkerMigrationMetadata = {
    ...(currentTag ? { old_tag: currentTag } : {}),
    new_tag: GOODVIBES_DO_MIGRATION_TAG,
    steps: [{ new_sqlite_classes: [DEFAULT_DO_NAMESPACE_NAME] }],
  };
  return {
    migrations,
    result: {
      durableObjectMigration: 'create-sqlite-class',
      migrationTag: GOODVIBES_DO_MIGRATION_TAG,
    },
  };
}

async function readWorkerMigrationTag(
  client: CloudflareApiClient,
  accountId: string,
  workerName: string,
): Promise<string> {
  try {
    const script = await client.workers.scripts.get?.(workerName, { account_id: accountId });
    const tag = clean(script?.migration_tag);
    if (tag) return tag;
  } catch (err) {
    logger.debug('worker-settings: failed to read migration tag via script get (falling back to list)', { error: summarizeError(err) });
  }

  const list = client.workers.scripts.list;
  if (!list) return '';
  try {
    const scripts = await collectAsync(list({ account_id: accountId }));
    const script = scripts.find((entry) => isMatchingWorkerScript(entry, workerName));
    return clean(script?.migration_tag);
  } catch (err) {
    logger.debug('worker-settings: failed to read migration tag via script list', { error: summarizeError(err) });
    return '';
  }
}

async function findExistingDurableObjectNamespace(
  client: CloudflareApiClient,
  accountId: string,
  workerName: string,
): Promise<CloudflareDurableObjectNamespaceLike | undefined> {
  if (!client.durableObjects) return undefined;
  try {
    for await (const namespace of client.durableObjects.namespaces.list({ account_id: accountId })) {
      const className = clean(namespace.class) || clean(namespace.name);
      const scriptName = clean(namespace.script);
      if (className === DEFAULT_DO_NAMESPACE_NAME && (!scriptName || scriptName === workerName)) {
        return namespace;
      }
    }
  } catch (err) {
    logger.debug('worker-settings: failed to list durable object namespaces', { error: summarizeError(err) });
    return undefined;
  }
  return undefined;
}

function isMatchingWorkerScript(
  script: CloudflareWorkerScriptLike,
  workerName: string,
): boolean {
  return script.id === workerName || script.name === workerName;
}

function isDurableObjectAlreadyMigratedError(error: unknown): boolean {
  const message = `${summarizeError(error)} ${error instanceof Error ? error.message : ''} ${stringifyError(error)}`.toLowerCase();
  return message.includes('10074') ||
    (message.includes('new-sqlite-class') && message.includes('already depended')) ||
    (message.includes('new_sqlite_classes') && message.includes('existing class'));
}

function stringifyError(error: unknown): string {
  try {
    return JSON.stringify(error) ?? '';
  } catch (err) {
    logger.debug('worker-settings: failed to stringify error object', { error: String(err) });
    return '';
  }
}

export async function configureWorkerSubdomain(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  input: {
    readonly accountId: string;
    readonly workerName: string;
    readonly requestedSubdomain?: string | undefined;
    readonly enableWorkersDev: boolean;
    readonly steps: CloudflareProvisionStep[];
    readonly persist: boolean;
  },
): Promise<string> {
  const requested = clean(input.requestedSubdomain) || context.readConfig().workerSubdomain;
  if (!input.enableWorkersDev) {
    input.steps.push({ name: 'worker-subdomain', status: 'skipped', message: 'workers.dev subdomain enablement was skipped.' });
    return requested;
  }

  let accountSubdomain = await readAccountWorkerSubdomain(client, input.accountId);
  if (accountSubdomain) {
    context.setConfig('cloudflare.workerSubdomain', accountSubdomain, input.persist);
    input.steps.push({
      name: 'account-worker-subdomain',
      status: requested && requested !== accountSubdomain ? 'warning' : 'ok',
      message: requested && requested !== accountSubdomain
        ? `Using existing account workers.dev subdomain ${accountSubdomain}; requested ${requested} was ignored because the account already has an associated subdomain.`
        : `Using account workers.dev subdomain ${accountSubdomain}.`,
    });
  } else if (requested) {
    try {
      const updated = await client.workers.subdomains.update({ account_id: input.accountId, subdomain: requested });
      accountSubdomain = clean(updated.subdomain) || requested;
      context.setConfig('cloudflare.workerSubdomain', accountSubdomain, input.persist);
      input.steps.push({ name: 'account-worker-subdomain', status: 'ok', message: `Configured account workers.dev subdomain ${accountSubdomain}.` });
    } catch (error: unknown) {
      const recovered = await readAccountWorkerSubdomain(client, input.accountId);
      if (!recovered) throw error;
      accountSubdomain = recovered;
      context.setConfig('cloudflare.workerSubdomain', accountSubdomain, input.persist);
      input.steps.push({
        name: 'account-worker-subdomain',
        status: requested === recovered ? 'ok' : 'warning',
        message: `Using existing account workers.dev subdomain ${accountSubdomain} after configure retry: ${summarizeError(error)}`,
      });
    }
  } else {
    input.steps.push({ name: 'account-worker-subdomain', status: 'warning', message: 'No account workers.dev subdomain is configured.' });
  }

  try {
    const existing = await client.workers.scripts.subdomain.get(input.workerName, { account_id: input.accountId });
    if (existing.enabled) {
      input.steps.push({ name: 'worker-subdomain', status: 'ok', message: `Using existing workers.dev route for ${input.workerName}.` });
      return accountSubdomain;
    }
  } catch (err) {
    logger.debug('worker-settings: failed to check existing worker subdomain state (expected on new accounts)', { error: summarizeError(err) });
  }
  try {
    await client.workers.scripts.subdomain.create(input.workerName, {
      account_id: input.accountId,
      enabled: true,
      previews_enabled: false,
    });
    input.steps.push({ name: 'worker-subdomain', status: 'ok', message: `Enabled workers.dev route for ${input.workerName}.` });
  } catch (error: unknown) {
    const recovered = await client.workers.scripts.subdomain.get(input.workerName, { account_id: input.accountId });
    if (!recovered.enabled) throw error;
    input.steps.push({ name: 'worker-subdomain', status: 'ok', message: `Using existing workers.dev route for ${input.workerName} after enable retry: ${summarizeError(error)}` });
  }
  return accountSubdomain;
}

export async function configureWorkerSchedule(
  client: CloudflareApiClient,
  input: {
    readonly accountId: string;
    readonly workerName: string;
    readonly workerCron: string;
    readonly steps: CloudflareProvisionStep[];
  },
): Promise<void> {
  const body = [{ cron: input.workerCron }];
  try {
    const existing = await client.workers.scripts.schedules.get(input.workerName, { account_id: input.accountId });
    if (sameSchedules(existing.schedules, body)) {
      input.steps.push({ name: 'configure-cron', status: 'ok', message: `Using existing Worker cron ${input.workerCron}.` });
      return;
    }
  } catch (err) {
    logger.debug('worker-settings: failed to read existing cron schedule (expected on first deploy)', { error: summarizeError(err) });
  }
  await client.workers.scripts.schedules.update(input.workerName, { account_id: input.accountId, body });
  input.steps.push({ name: 'configure-cron', status: 'ok', message: `Configured Worker cron ${input.workerCron}.` });
}

export async function disableWorkerSchedule(
  client: CloudflareApiClient,
  accountId: string,
  workerName: string,
  steps: CloudflareProvisionStep[],
): Promise<void> {
  try {
    const existing = await client.workers.scripts.schedules.get(workerName, { account_id: accountId });
    if (existing.schedules.length === 0) {
      steps.push({ name: 'disable-cron', status: 'skipped', message: `No Worker cron schedules were configured for ${workerName}.` });
      return;
    }
  } catch (err) {
    logger.debug('worker-settings: failed to read cron schedule before disable (clearing anyway)', { error: summarizeError(err) });
  }
  await client.workers.scripts.schedules.update(workerName, { account_id: accountId, body: [] });
  steps.push({ name: 'disable-cron', status: 'ok', message: `Removed Worker cron schedules from ${workerName}.` });
}

export async function disableWorkerSubdomain(
  client: CloudflareApiClient,
  accountId: string,
  workerName: string,
  steps: CloudflareProvisionStep[],
): Promise<void> {
  try {
    const existing = await client.workers.scripts.subdomain.get(workerName, { account_id: accountId });
    if (!existing.enabled) {
      steps.push({ name: 'disable-worker-subdomain', status: 'skipped', message: `workers.dev route was already disabled for ${workerName}.` });
      return;
    }
  } catch (err) {
    // Keep disable best-effort: if state cannot be read, attempt deletion.
    logger.debug('disableWorkerSubdomain: failed to read existing subdomain state, attempting delete anyway', { workerName, error: summarizeError(err) });
  }
  await client.workers.scripts.subdomain.delete(workerName, { account_id: accountId });
  steps.push({ name: 'disable-worker-subdomain', status: 'ok', message: `Disabled workers.dev route for ${workerName}.` });
}

async function readAccountWorkerSubdomain(
  client: CloudflareApiClient,
  accountId: string,
): Promise<string> {
  try {
    return clean((await client.workers.subdomains.get({ account_id: accountId })).subdomain);
  } catch (err) {
    logger.debug('readAccountWorkerSubdomain: failed to read account worker subdomain', { accountId, error: summarizeError(err) });
    return '';
  }
}

function sameSchedules(
  actual: readonly { readonly cron: string }[],
  expected: readonly { readonly cron: string }[],
): boolean {
  return actual.length === expected.length && actual.every((schedule, index) => schedule.cron === expected[index]?.cron);
}
