import type { ConfigKey } from '../config/schema.js';
import { resolveSecretInput } from '../config/secret-refs.js';
import { summarizeError } from '../utils/error-display.js';
import { createCloudflareApiClient } from './client.js';
import { GOODVIBES_CLOUDFLARE_WORKER_MODULE } from './worker-source.js';
import type {
  CloudflareApiClient,
  CloudflareConsumerLike,
  CloudflareControlPlaneConfig,
  CloudflareControlPlaneOptions,
  CloudflareControlPlaneStatus,
  CloudflareDisableInput,
  CloudflareDisableResult,
  CloudflareProvisionInput,
  CloudflareProvisionResult,
  CloudflareProvisionStep,
  CloudflareQueueLike,
  CloudflareResolvedSecret,
  CloudflareValidateInput,
  CloudflareValidateResult,
  CloudflareVerifyInput,
  CloudflareVerifyResult,
} from './types.js';
import { CloudflareControlPlaneError } from './types.js';

const DEFAULT_WORKER_NAME = 'goodvibes-batch-worker';
const DEFAULT_QUEUE_NAME = 'goodvibes-batch';
const DEFAULT_DLQ_NAME = 'goodvibes-batch-dlq';
const DEFAULT_WORKER_CRON = '*/5 * * * *';
const CLOUDFLARE_API_TOKEN_KEY = 'CLOUDFLARE_API_TOKEN';
const CLOUDFLARE_WORKER_CLIENT_TOKEN_KEY = 'GOODVIBES_CLOUDFLARE_WORKER_TOKEN';
const CLOUDFLARE_WORKER_OPERATOR_TOKEN_KEY = 'GOODVIBES_CLOUDFLARE_OPERATOR_TOKEN';

export class CloudflareControlPlaneManager {
  private readonly createClient: (apiToken: string) => Promise<CloudflareApiClient>;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CloudflareControlPlaneOptions) {
    this.createClient = options.createClient ?? createCloudflareApiClient;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async describeStatus(): Promise<CloudflareControlPlaneStatus> {
    const config = this.readConfig();
    const apiToken = await this.resolveApiToken({});
    const workerToken = await this.resolveOperatorToken({});
    const workerClientToken = await this.resolveWorkerClientToken({});
    const configured = {
      accountId: config.accountId.length > 0,
      apiToken: apiToken.value !== null,
      workerName: config.workerName.length > 0,
      daemonBaseUrl: config.daemonBaseUrl.length > 0,
      workerBaseUrl: config.workerBaseUrl.length > 0,
      queueName: config.queueName.length > 0,
      deadLetterQueueName: config.deadLetterQueueName.length > 0,
      workerToken: workerToken.value !== null,
      workerClientToken: workerClientToken.value !== null,
    };
    const warnings: string[] = [];
    if (config.enabled && !configured.apiToken) warnings.push('Cloudflare is enabled but no API token is configured.');
    if (config.enabled && !configured.daemonBaseUrl) warnings.push('Cloudflare is enabled but no daemonBaseUrl is configured for Worker-to-daemon calls.');
    if (config.enabled && !configured.workerToken) warnings.push('Cloudflare is enabled but no Worker-to-daemon operator token is configured.');
    if (config.enabled && !configured.workerClientToken) warnings.push('Cloudflare Worker client auth is not configured; provisioning will generate one.');
    const ready = config.enabled &&
      configured.accountId &&
      configured.apiToken &&
      configured.workerName &&
      configured.daemonBaseUrl &&
      configured.workerBaseUrl &&
      configured.queueName &&
      configured.deadLetterQueueName &&
      configured.workerToken;
    return { enabled: config.enabled, ready, configured, config, warnings };
  }

  async validate(input: CloudflareValidateInput): Promise<CloudflareValidateResult> {
    const accountId = this.resolveAccountId(input.accountId);
    const apiToken = await this.resolveApiToken(input);
    if (!apiToken.value) {
      throw new CloudflareControlPlaneError(
        'Cloudflare API token is required. Set CLOUDFLARE_API_TOKEN, configure cloudflare.apiTokenRef, or pass apiToken.',
        'CLOUDFLARE_API_TOKEN_REQUIRED',
        400,
      );
    }
    const client = await this.createClient(apiToken.value);
    const account = await client.accounts.get({ account_id: accountId });
    return {
      ok: true,
      account: {
        id: account.id,
        name: account.name,
        ...(account.type ? { type: account.type } : {}),
      },
      tokenSource: apiToken.source,
    };
  }

  async provision(input: CloudflareProvisionInput): Promise<CloudflareProvisionResult> {
    const steps: CloudflareProvisionStep[] = [];
    const persist = input.persistConfig !== false;
    const accountId = this.resolveAccountId(input.accountId);
    const workerName = this.resolveWorkerName(input.workerName);
    const queueName = clean(input.queueName) || this.readConfig().queueName || DEFAULT_QUEUE_NAME;
    const deadLetterQueueName = clean(input.deadLetterQueueName) || this.readConfig().deadLetterQueueName || DEFAULT_DLQ_NAME;
    const daemonBaseUrl = stripTrailingSlash(clean(input.daemonBaseUrl) || this.readConfig().daemonBaseUrl);
    const workerCron = clean(input.workerCron) || this.readConfig().workerCron || DEFAULT_WORKER_CRON;
    const queueJobPayloads = input.queueJobPayloads === true;

    if (!daemonBaseUrl) {
      throw new CloudflareControlPlaneError(
        'cloudflare.daemonBaseUrl is required so the deployed Worker can reach the GoodVibes daemon.',
        'CLOUDFLARE_DAEMON_URL_REQUIRED',
        400,
      );
    }

    const apiToken = await this.resolveApiToken(input);
    if (!apiToken.value) {
      throw new CloudflareControlPlaneError(
        'Cloudflare API token is required. Set CLOUDFLARE_API_TOKEN, configure cloudflare.apiTokenRef, or pass apiToken.',
        'CLOUDFLARE_API_TOKEN_REQUIRED',
        400,
      );
    }

    if (input.storeApiToken && input.apiToken) {
      await this.storeSecret(CLOUDFLARE_API_TOKEN_KEY, input.apiToken);
      this.setConfig('cloudflare.apiTokenRef', `goodvibes://secrets/goodvibes/${CLOUDFLARE_API_TOKEN_KEY}`, persist);
      steps.push({ name: 'store-api-token', status: 'ok', message: 'Stored Cloudflare API token in the GoodVibes secret store.' });
    }

    const client = await this.createClient(apiToken.value);
    const account = await client.accounts.get({ account_id: accountId });
    steps.push({ name: 'validate-account', status: 'ok', message: `Validated Cloudflare account ${account.name}.`, resourceId: account.id });

    const deadLetterQueue = await this.ensureQueue(client, accountId, deadLetterQueueName, steps, 'dead-letter-queue');
    const queue = await this.ensureQueue(client, accountId, queueName, steps, 'queue');
    const deadLetterQueueId = requireQueueId(deadLetterQueue, deadLetterQueueName);
    const queueId = requireQueueId(queue, queueName);

    await this.uploadWorker(client, {
      accountId,
      workerName,
      queueName,
      daemonBaseUrl,
      queueJobPayloads,
    });
    steps.push({ name: 'deploy-worker', status: 'ok', message: `Uploaded Worker ${workerName}.`, resourceId: workerName });

    const operatorToken = await this.resolveOperatorToken(input);
    if (!operatorToken.value) {
      throw new CloudflareControlPlaneError(
        'A Worker-to-daemon operator token is required. Pass operatorToken, configure cloudflare.workerTokenRef, or ensure the daemon has an operator token.',
        'CLOUDFLARE_OPERATOR_TOKEN_REQUIRED',
        400,
      );
    }
    if (input.storeOperatorToken && input.operatorToken) {
      await this.storeSecret(CLOUDFLARE_WORKER_OPERATOR_TOKEN_KEY, input.operatorToken);
      this.setConfig('cloudflare.workerTokenRef', `goodvibes://secrets/goodvibes/${CLOUDFLARE_WORKER_OPERATOR_TOKEN_KEY}`, persist);
      steps.push({ name: 'store-worker-token', status: 'ok', message: 'Stored Worker-to-daemon token in the GoodVibes secret store.' });
    }
    await client.workers.scripts.secrets.update(workerName, {
      account_id: accountId,
      name: 'GOODVIBES_OPERATOR_TOKEN',
      text: operatorToken.value,
      type: 'secret_text',
    });
    steps.push({ name: 'set-worker-daemon-secret', status: 'ok', message: 'Configured Worker-to-daemon bearer token secret.' });

    const workerClientToken = await this.resolveWorkerClientToken(input);
    let generatedWorkerClientToken: string | undefined;
    let effectiveWorkerClientToken = workerClientToken.value;
    if (!effectiveWorkerClientToken) {
      effectiveWorkerClientToken = this.generateToken();
      generatedWorkerClientToken = effectiveWorkerClientToken;
      await this.storeSecret(CLOUDFLARE_WORKER_CLIENT_TOKEN_KEY, effectiveWorkerClientToken);
      this.setConfig('cloudflare.workerClientTokenRef', `goodvibes://secrets/goodvibes/${CLOUDFLARE_WORKER_CLIENT_TOKEN_KEY}`, persist);
      steps.push({ name: 'generate-worker-client-token', status: 'ok', message: 'Generated and stored Worker client bearer token.' });
    } else if (input.storeWorkerClientToken && input.workerClientToken) {
      await this.storeSecret(CLOUDFLARE_WORKER_CLIENT_TOKEN_KEY, input.workerClientToken);
      this.setConfig('cloudflare.workerClientTokenRef', `goodvibes://secrets/goodvibes/${CLOUDFLARE_WORKER_CLIENT_TOKEN_KEY}`, persist);
      steps.push({ name: 'store-worker-client-token', status: 'ok', message: 'Stored Worker client bearer token in the GoodVibes secret store.' });
    }
    await client.workers.scripts.secrets.update(workerName, {
      account_id: accountId,
      name: 'GOODVIBES_WORKER_TOKEN',
      text: effectiveWorkerClientToken,
      type: 'secret_text',
    });
    steps.push({ name: 'set-worker-client-secret', status: 'ok', message: 'Configured Worker client bearer token secret.' });

    const subdomain = await this.configureWorkerSubdomain(client, {
      accountId,
      workerName,
      requestedSubdomain: input.workerSubdomain,
      enableWorkersDev: input.enableWorkersDev !== false,
      steps,
      persist,
    });
    const configuredWorkerBaseUrl = stripTrailingSlash(clean(input.workerBaseUrl) || this.readConfig().workerBaseUrl);
    const inferredWorkerBaseUrl = subdomain ? `https://${workerName}.${subdomain}.workers.dev` : '';
    const workerBaseUrl = configuredWorkerBaseUrl || inferredWorkerBaseUrl;
    if (workerBaseUrl) {
      this.setConfig('cloudflare.workerBaseUrl', workerBaseUrl, persist);
    } else {
      steps.push({
        name: 'worker-base-url',
        status: 'warning',
        message: 'Could not infer workerBaseUrl. Configure cloudflare.workerBaseUrl after assigning a custom route or workers.dev subdomain.',
      });
    }

    if (workerCron) {
      await client.workers.scripts.schedules.update(workerName, {
        account_id: accountId,
        body: [{ cron: workerCron }],
      });
      steps.push({ name: 'configure-cron', status: 'ok', message: `Configured Worker cron ${workerCron}.` });
    } else {
      steps.push({ name: 'configure-cron', status: 'skipped', message: 'No Worker cron configured.' });
    }

    const consumer = await this.ensureQueueConsumer(client, {
      accountId,
      queueId,
      workerName,
      deadLetterQueueName,
      steps,
    });

    this.setConfig('cloudflare.enabled', true, persist);
    this.setConfig('cloudflare.accountId', accountId, persist);
    this.setConfig('cloudflare.workerName', workerName, persist);
    this.setConfig('cloudflare.daemonBaseUrl', daemonBaseUrl, persist);
    this.setConfig('cloudflare.queueName', queueName, persist);
    this.setConfig('cloudflare.deadLetterQueueName', deadLetterQueueName, persist);
    this.setConfig('cloudflare.workerCron', workerCron, persist);
    this.setConfig('batch.queueBackend', 'cloudflare', persist);
    if (input.batchMode) this.setConfig('batch.mode', input.batchMode, persist);

    const verification = input.verify === false || !workerBaseUrl
      ? undefined
      : await this.verify({ workerBaseUrl, workerClientToken: effectiveWorkerClientToken });
    if (verification) {
      steps.push({
        name: 'verify-worker',
        status: verification.ok ? 'ok' : 'warning',
        message: verification.ok ? 'Verified Worker health and daemon batch proxy.' : 'Worker verification completed with warnings.',
      });
    }

    return {
      ok: true,
      dryRun: false,
      steps,
      account: { id: account.id, name: account.name },
      queues: {
        queueName,
        queueId,
        deadLetterQueueName,
        deadLetterQueueId,
        ...(consumer.consumer_id ? { consumerId: consumer.consumer_id } : {}),
      },
      worker: {
        name: workerName,
        ...(workerBaseUrl ? { baseUrl: workerBaseUrl } : {}),
        ...(subdomain ? { subdomain } : {}),
        ...(workerCron ? { cron: workerCron } : {}),
      },
      ...(verification ? { verification } : {}),
      ...(generatedWorkerClientToken && input.returnGeneratedSecrets
        ? { generatedSecrets: { workerClientToken: generatedWorkerClientToken } }
        : {}),
    };
  }

  async verify(input: CloudflareVerifyInput = {}): Promise<CloudflareVerifyResult> {
    const workerBaseUrl = stripTrailingSlash(clean(input.workerBaseUrl) || this.readConfig().workerBaseUrl);
    if (!workerBaseUrl) {
      throw new CloudflareControlPlaneError('cloudflare.workerBaseUrl is required for verification.', 'CLOUDFLARE_WORKER_URL_REQUIRED', 400);
    }
    const workerClientToken = await this.resolveWorkerClientToken(input);
    const health = await this.fetchWorker(`${workerBaseUrl}/batch/health`);
    const proxy = await this.fetchWorker(`${workerBaseUrl}/api/batch/config`, workerClientToken.value ?? undefined);
    return {
      ok: health.ok && proxy.ok,
      workerHealth: health,
      daemonBatchProxy: proxy,
    };
  }

  async disable(input: CloudflareDisableInput = {}): Promise<CloudflareDisableResult> {
    const steps: CloudflareProvisionStep[] = [];
    const persist = input.persistConfig !== false;
    const accountId = clean(input.accountId) || this.readConfig().accountId;
    const workerName = clean(input.workerName) || this.readConfig().workerName || DEFAULT_WORKER_NAME;
    const apiToken = await this.resolveApiToken(input);

    if (apiToken.value && accountId) {
      const client = await this.createClient(apiToken.value);
      if (input.disableCron !== false) {
        await client.workers.scripts.schedules.update(workerName, { account_id: accountId, body: [] });
        steps.push({ name: 'disable-cron', status: 'ok', message: `Removed Worker cron schedules from ${workerName}.` });
      }
      if (input.disableWorkerSubdomain) {
        await client.workers.scripts.subdomain.delete(workerName, { account_id: accountId });
        steps.push({ name: 'disable-worker-subdomain', status: 'ok', message: `Disabled workers.dev route for ${workerName}.` });
      }
    } else {
      steps.push({ name: 'cloudflare-api', status: 'skipped', message: 'No Cloudflare API token/account configured; only local config was disabled.' });
    }

    this.setConfig('cloudflare.enabled', false, persist);
    this.setConfig('batch.queueBackend', 'local', persist);
    return { ok: true, steps };
  }

  private readConfig(): CloudflareControlPlaneConfig {
    return {
      enabled: this.getBooleanConfig('cloudflare.enabled', false),
      freeTierMode: this.getBooleanConfig('cloudflare.freeTierMode', true),
      accountId: this.getStringConfig('cloudflare.accountId', ''),
      apiTokenRef: this.getStringConfig('cloudflare.apiTokenRef', ''),
      workerName: this.getStringConfig('cloudflare.workerName', DEFAULT_WORKER_NAME),
      workerSubdomain: this.getStringConfig('cloudflare.workerSubdomain', ''),
      workerBaseUrl: this.getStringConfig('cloudflare.workerBaseUrl', ''),
      daemonBaseUrl: this.getStringConfig('cloudflare.daemonBaseUrl', ''),
      workerTokenRef: this.getStringConfig('cloudflare.workerTokenRef', ''),
      workerClientTokenRef: this.getStringConfig('cloudflare.workerClientTokenRef', ''),
      workerCron: this.getStringConfig('cloudflare.workerCron', DEFAULT_WORKER_CRON),
      queueName: this.getStringConfig('cloudflare.queueName', DEFAULT_QUEUE_NAME),
      deadLetterQueueName: this.getStringConfig('cloudflare.deadLetterQueueName', DEFAULT_DLQ_NAME),
      maxQueueOpsPerDay: this.getNumberConfig('cloudflare.maxQueueOpsPerDay', 10_000),
    };
  }

  private resolveAccountId(inputAccountId: string | undefined): string {
    const accountId = clean(inputAccountId) || this.readConfig().accountId;
    if (!accountId) {
      throw new CloudflareControlPlaneError(
        'Cloudflare account id is required. Configure cloudflare.accountId or pass accountId.',
        'CLOUDFLARE_ACCOUNT_REQUIRED',
        400,
      );
    }
    return accountId;
  }

  private resolveWorkerName(inputWorkerName: string | undefined): string {
    const workerName = clean(inputWorkerName) || this.readConfig().workerName || DEFAULT_WORKER_NAME;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(workerName)) {
      throw new CloudflareControlPlaneError(
        'Cloudflare workerName must be 1-63 characters using letters, numbers, and dashes.',
        'CLOUDFLARE_WORKER_NAME_INVALID',
        400,
      );
    }
    return workerName;
  }

  private async resolveApiToken(input: CloudflareValidateInput): Promise<CloudflareResolvedSecret> {
    const bodyToken = clean(input.apiToken);
    if (bodyToken) return { value: bodyToken, source: 'body' };
    const ref = clean(input.apiTokenRef) || this.readConfig().apiTokenRef;
    const fromRef = await this.resolveSecretRef(ref);
    if (fromRef.value) return { value: fromRef.value, source: 'config-ref' };
    const envToken = clean(process.env['CLOUDFLARE_API_TOKEN']);
    if (envToken) return { value: envToken, source: 'env' };
    const stored = await this.options.secretsManager?.get(CLOUDFLARE_API_TOKEN_KEY) ?? null;
    if (stored) return { value: stored, source: 'goodvibes-secret' };
    return { value: null, source: 'missing' };
  }

  private async resolveOperatorToken(input: Pick<CloudflareProvisionInput, 'operatorToken' | 'operatorTokenRef'>): Promise<CloudflareResolvedSecret> {
    const bodyToken = clean(input.operatorToken);
    if (bodyToken) return { value: bodyToken, source: 'body' };
    const ref = clean(input.operatorTokenRef) || this.readConfig().workerTokenRef;
    const fromRef = await this.resolveSecretRef(ref);
    if (fromRef.value) return { value: fromRef.value, source: 'config-ref' };
    const stored = await this.options.secretsManager?.get(CLOUDFLARE_WORKER_OPERATOR_TOKEN_KEY) ?? null;
    if (stored) return { value: stored, source: 'goodvibes-secret' };
    const authToken = clean(this.options.authToken?.() ?? undefined);
    if (authToken) return { value: authToken, source: 'auth-token' };
    return { value: null, source: 'missing' };
  }

  private async resolveWorkerClientToken(input: Pick<CloudflareProvisionInput, 'workerClientToken' | 'workerClientTokenRef'>): Promise<CloudflareResolvedSecret> {
    const bodyToken = clean(input.workerClientToken);
    if (bodyToken) return { value: bodyToken, source: 'body' };
    const ref = clean(input.workerClientTokenRef) || this.readConfig().workerClientTokenRef;
    const fromRef = await this.resolveSecretRef(ref);
    if (fromRef.value) return { value: fromRef.value, source: 'config-ref' };
    const envToken = clean(process.env['GOODVIBES_CLOUDFLARE_WORKER_TOKEN']);
    if (envToken) return { value: envToken, source: 'env' };
    const stored = await this.options.secretsManager?.get(CLOUDFLARE_WORKER_CLIENT_TOKEN_KEY) ?? null;
    if (stored) return { value: stored, source: 'goodvibes-secret' };
    return { value: null, source: 'missing' };
  }

  private async resolveSecretRef(ref: string): Promise<CloudflareResolvedSecret> {
    if (!ref) return { value: null, source: 'missing' };
    try {
      const value = await resolveSecretInput(ref, {
        resolveLocalSecret: async (key) => await this.options.secretsManager?.get(key) ?? null,
        homeDirectory: this.options.secretsManager?.getGlobalHome(),
      });
      return value ? { value, source: 'config-ref' } : { value: null, source: 'missing' };
    } catch {
      return { value: null, source: 'missing' };
    }
  }

  private async storeSecret(key: string, value: string): Promise<void> {
    if (!this.options.secretsManager?.set) {
      throw new CloudflareControlPlaneError('SecretsManager is required to store Cloudflare tokens.', 'SECRETS_MANAGER_REQUIRED', 500);
    }
    await this.options.secretsManager.set(key, value, { scope: 'user', medium: 'secure' });
  }

  private async ensureQueue(
    client: CloudflareApiClient,
    accountId: string,
    queueName: string,
    steps: CloudflareProvisionStep[],
    stepName: string,
  ): Promise<CloudflareQueueLike> {
    for await (const queue of client.queues.list({ account_id: accountId })) {
      if (queue.queue_name === queueName) {
        steps.push({ name: stepName, status: 'ok', message: `Using existing Cloudflare Queue ${queueName}.`, resourceId: queue.queue_id });
        return queue;
      }
    }
    const created = await client.queues.create({ account_id: accountId, queue_name: queueName });
    steps.push({ name: stepName, status: 'ok', message: `Created Cloudflare Queue ${queueName}.`, resourceId: created.queue_id });
    return created;
  }

  private async uploadWorker(
    client: CloudflareApiClient,
    input: {
      readonly accountId: string;
      readonly workerName: string;
      readonly queueName: string;
      readonly daemonBaseUrl: string;
      readonly queueJobPayloads: boolean;
    },
  ): Promise<void> {
    const file = new File(
      [GOODVIBES_CLOUDFLARE_WORKER_MODULE],
      'goodvibes-cloudflare-worker.mjs',
      { type: 'application/javascript+module' },
    );
    await client.workers.scripts.update(input.workerName, {
      account_id: input.accountId,
      metadata: {
        main_module: 'goodvibes-cloudflare-worker.mjs',
        compatibility_date: '2026-04-25',
        bindings: [
          { type: 'queue', name: 'GOODVIBES_BATCH_QUEUE', queue_name: input.queueName },
          { type: 'plain_text', name: 'GOODVIBES_DAEMON_URL', text: input.daemonBaseUrl },
          { type: 'plain_text', name: 'GOODVIBES_QUEUE_JOB_PAYLOADS', text: input.queueJobPayloads ? 'true' : 'false' },
        ],
        keep_bindings: ['secret_text'],
      },
      files: [file],
    });
  }

  private async configureWorkerSubdomain(
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
    if (!input.enableWorkersDev) {
      input.steps.push({ name: 'worker-subdomain', status: 'skipped', message: 'workers.dev subdomain enablement was skipped.' });
      return clean(input.requestedSubdomain) || this.readConfig().workerSubdomain;
    }

    let accountSubdomain = clean(input.requestedSubdomain) || this.readConfig().workerSubdomain;
    if (accountSubdomain) {
      const updated = await client.workers.subdomains.update({ account_id: input.accountId, subdomain: accountSubdomain });
      accountSubdomain = updated.subdomain;
      this.setConfig('cloudflare.workerSubdomain', accountSubdomain, input.persist);
      input.steps.push({ name: 'account-worker-subdomain', status: 'ok', message: `Configured account workers.dev subdomain ${accountSubdomain}.` });
    } else {
      try {
        const existing = await client.workers.subdomains.get({ account_id: input.accountId });
        accountSubdomain = existing.subdomain;
        this.setConfig('cloudflare.workerSubdomain', accountSubdomain, input.persist);
        input.steps.push({ name: 'account-worker-subdomain', status: 'ok', message: `Using account workers.dev subdomain ${accountSubdomain}.` });
      } catch (error: unknown) {
        input.steps.push({
          name: 'account-worker-subdomain',
          status: 'warning',
          message: `Could not read account workers.dev subdomain: ${summarizeError(error)}`,
        });
      }
    }

    await client.workers.scripts.subdomain.create(input.workerName, {
      account_id: input.accountId,
      enabled: true,
      previews_enabled: false,
    });
    input.steps.push({ name: 'worker-subdomain', status: 'ok', message: `Enabled workers.dev route for ${input.workerName}.` });
    return accountSubdomain;
  }

  private async ensureQueueConsumer(
    client: CloudflareApiClient,
    input: {
      readonly accountId: string;
      readonly queueId: string;
      readonly workerName: string;
      readonly deadLetterQueueName: string;
      readonly steps: CloudflareProvisionStep[];
    },
  ): Promise<CloudflareConsumerLike> {
    const settings = {
      batch_size: 10,
      max_retries: 3,
      max_wait_time_ms: 5000,
      retry_delay: 60,
    };
    for await (const consumer of client.queues.consumers.list(input.queueId, { account_id: input.accountId })) {
      if (consumer.type === 'worker' && consumer.script === input.workerName && consumer.consumer_id) {
        const updated = await client.queues.consumers.update(input.queueId, consumer.consumer_id, {
          account_id: input.accountId,
          type: 'worker',
          script_name: input.workerName,
          dead_letter_queue: input.deadLetterQueueName,
          settings,
        });
        input.steps.push({ name: 'queue-consumer', status: 'ok', message: `Updated Queue consumer for ${input.workerName}.`, resourceId: updated.consumer_id });
        return updated;
      }
    }
    const created = await client.queues.consumers.create(input.queueId, {
      account_id: input.accountId,
      type: 'worker',
      script_name: input.workerName,
      dead_letter_queue: input.deadLetterQueueName,
      settings,
    });
    input.steps.push({ name: 'queue-consumer', status: 'ok', message: `Created Queue consumer for ${input.workerName}.`, resourceId: created.consumer_id });
    return created;
  }

  private async fetchWorker(url: string, bearerToken?: string): Promise<{ readonly ok: boolean; readonly status: number; readonly error?: string }> {
    try {
      const headers = new Headers();
      if (bearerToken) headers.set('Authorization', `Bearer ${bearerToken}`);
      const response = await this.fetchImpl(url, { headers });
      return response.ok
        ? { ok: true, status: response.status }
        : { ok: false, status: response.status, error: await safeResponseText(response) };
    } catch (error: unknown) {
      return { ok: false, status: 0, error: summarizeError(error) };
    }
  }

  private generateToken(): string {
    const id = this.options.randomUUID?.() ?? globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);
    return `gv-cf-${id.replace(/[^a-zA-Z0-9]/g, '')}`;
  }

  private setConfig(key: ConfigKey, value: unknown, persist: boolean): void {
    if (!persist) return;
    const set = this.options.configManager.set as unknown as (configKey: ConfigKey, configValue: unknown) => void;
    set.call(this.options.configManager, key, value);
  }

  private getStringConfig(key: ConfigKey, fallback: string): string {
    const value = this.options.configManager.get(key);
    return typeof value === 'string' ? value : fallback;
  }

  private getBooleanConfig(key: ConfigKey, fallback: boolean): boolean {
    const value = this.options.configManager.get(key);
    return typeof value === 'boolean' ? value : fallback;
  }

  private getNumberConfig(key: ConfigKey, fallback: number): number {
    const value = this.options.configManager.get(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }
}

function clean(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function requireQueueId(queue: CloudflareQueueLike, queueName: string): string {
  if (queue.queue_id) return queue.queue_id;
  throw new CloudflareControlPlaneError(`Cloudflare Queue '${queueName}' did not include a queue_id.`, 'CLOUDFLARE_QUEUE_ID_MISSING', 502);
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText;
  }
}
