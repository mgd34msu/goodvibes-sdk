import { summarizeError } from '../utils/error-display.js';
import { DEFAULT_DO_NAMESPACE_NAME } from './constants.js';
import type {
  CloudflareApiClient,
  CloudflareProvisionStep,
} from './types.js';
import { clean } from './utils.js';
import { GOODVIBES_CLOUDFLARE_WORKER_MODULE } from './worker-source.js';
import type { CloudflareProvisioningContext } from './resources.js';

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
): Promise<void> {
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
  await client.workers.scripts.update(input.workerName, {
    account_id: input.accountId,
    metadata: {
      main_module: 'goodvibes-cloudflare-worker.mjs',
      compatibility_date: '2026-04-25',
      bindings,
      ...(input.durableObject ? { migrations: { tag: 'goodvibes-coordinator-v1', new_sqlite_classes: [DEFAULT_DO_NAMESPACE_NAME] } } : {}),
      keep_bindings: ['secret_text'],
    },
    files: [file],
  });
}

export async function configureWorkerSubdomain(
  context: CloudflareProvisioningContext,
  client: CloudflareApiClient,
  input: {
    readonly accountId: string;
    readonly workerName: string;
    readonly requestedSubdomain?: string;
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
  } catch {
    // Older accounts may not return script-level subdomain state before it is enabled.
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
  } catch {
    // Some accounts return 404 until the script has its first schedule.
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
  } catch {
    // Keep disable best-effort: if state cannot be read, clear schedules anyway.
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
  } catch {
    // Keep disable best-effort: if state cannot be read, attempt deletion.
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
  } catch {
    return '';
  }
}

function sameSchedules(
  actual: readonly { readonly cron: string }[],
  expected: readonly { readonly cron: string }[],
): boolean {
  return actual.length === expected.length && actual.every((schedule, index) => schedule.cron === expected[index]?.cron);
}
