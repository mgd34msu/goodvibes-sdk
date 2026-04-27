import type { ConfigKey } from '../config/schema.js';
import { resolveSecretInput } from '../config/secret-refs.js';
import { summarizeError } from '../utils/error-display.js';
import { createCloudflareApiClient } from './client.js';
import { readCloudflareConfig } from './config.js';
import {
  CLOUDFLARE_API_TOKEN_KEY,
  CLOUDFLARE_WORKER_CLIENT_TOKEN_KEY,
  CLOUDFLARE_WORKER_OPERATOR_TOKEN_KEY,
  DEFAULT_DLQ_NAME,
  DEFAULT_DO_NAMESPACE_NAME,
  DEFAULT_KV_NAMESPACE_NAME,
  DEFAULT_QUEUE_NAME,
  DEFAULT_R2_BUCKET_NAME,
  DEFAULT_SECRETS_STORE_NAME,
  DEFAULT_TUNNEL_NAME,
  DEFAULT_WORKER_CRON,
  DEFAULT_WORKER_NAME,
} from './constants.js';
import {
  discoverZones,
  resolveZone,
  selectDiscoveredZone,
  tryDiscover,
} from './discovery.js';
import {
  configureDns,
  configureWorkerSubdomain,
  ensureAccess,
  ensureKvNamespace,
  ensureQueue,
  ensureQueueConsumer,
  ensureR2Bucket,
  ensureSecretsStore,
  ensureTunnel,
  findDurableObjectNamespace,
  type CloudflareProvisioningContext,
  uploadWorker,
} from './resources.js';
import type {
  CloudflareAccessApplicationLike,
  CloudflareApiClient,
  CloudflareControlPlaneConfig,
  CloudflareControlPlaneOptions,
  CloudflareControlPlaneStatus,
  CloudflareDiscoverInput,
  CloudflareDiscoverResult,
  CloudflareDisableInput,
  CloudflareDisableResult,
  CloudflareDurableObjectNamespaceLike,
  CloudflareKvNamespaceLike,
  CloudflareOperationalTokenInput,
  CloudflareOperationalTokenResult,
  CloudflareProvisionInput,
  CloudflareProvisionResult,
  CloudflareProvisionStep,
  CloudflareQueueLike,
  CloudflareR2BucketLike,
  CloudflareResolvedSecret,
  CloudflareSecretsStoreLike,
  CloudflareTokenRequirementsInput,
  CloudflareTokenRequirementsResult,
  CloudflareTunnelLike,
  CloudflareValidateInput,
  CloudflareValidateResult,
  CloudflareVerifyInput,
  CloudflareVerifyResult,
} from './types.js';
import { CloudflareControlPlaneError } from './types.js';
import {
  buildTokenPolicies,
  buildTokenRequirements,
  clean,
  collectAsync,
  collectSingleAccount,
  hostnameFromUrl,
  requireKvNamespaceId,
  requireQueueId,
  resolveComponents,
  resolvePermissionGroups,
  safeResponseText,
  stripTrailingSlash,
  verifyCreatedTokenPolicies,
} from './utils.js';

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
      zone: config.zoneId.length > 0 || config.zoneName.length > 0,
      workerName: config.workerName.length > 0,
      daemonBaseUrl: config.daemonBaseUrl.length > 0,
      daemonHostname: config.daemonHostname.length > 0,
      workerBaseUrl: config.workerBaseUrl.length > 0,
      workerHostname: config.workerHostname.length > 0,
      queueName: config.queueName.length > 0,
      deadLetterQueueName: config.deadLetterQueueName.length > 0,
      workerToken: workerToken.value !== null,
      workerClientToken: workerClientToken.value !== null,
      tunnel: config.tunnelId.length > 0 || config.tunnelName.length > 0,
      access: config.accessAppId.length > 0 || config.accessServiceTokenId.length > 0 || config.accessServiceTokenRef.length > 0,
      kv: config.kvNamespaceId.length > 0 || config.kvNamespaceName.length > 0,
      durableObjects: config.durableObjectNamespaceId.length > 0 || config.durableObjectNamespaceName.length > 0,
      r2: config.r2BucketName.length > 0,
      secretsStore: config.secretsStoreId.length > 0 || config.secretsStoreName.length > 0,
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

  tokenRequirements(input: CloudflareTokenRequirementsInput = {}): CloudflareTokenRequirementsResult {
    const components = resolveComponents(input.components);
    return {
      ok: true,
      components,
      permissions: buildTokenRequirements(components, input.includeBootstrap === true),
      bootstrapToken: {
        requiredForSdkCreation: true,
        storeInGoodVibes: false,
        instructions: [
          'Create a temporary user-owned Cloudflare API token from the Create additional tokens template, or grant the User > API Tokens Write permission.',
          'Pass that temporary token as bootstrapToken to POST /api/cloudflare/token/create.',
          'The SDK uses Cloudflare user-token APIs to create a narrower operational token with the GoodVibes permissions listed here, stores only the operational token as a goodvibes:// secret when requested, and never persists the bootstrap token.',
        ],
      },
    };
  }

  async createOperationalToken(input: CloudflareOperationalTokenInput): Promise<CloudflareOperationalTokenResult> {
    const bootstrapToken = clean(input.bootstrapToken);
    if (!bootstrapToken) {
      throw new CloudflareControlPlaneError(
        'bootstrapToken is required to create a Cloudflare operational token. The bootstrap token is used once and is not stored.',
        'CLOUDFLARE_BOOTSTRAP_TOKEN_REQUIRED',
        400,
      );
    }
    const persist = input.persistConfig !== false;
    const config = this.readConfig();
    const accountId = this.resolveAccountId(input.accountId);
    const components = resolveComponents(input.components);
    const requirements = buildTokenRequirements(components, false);
    const client = await this.createClient(bootstrapToken);
    const explicitZoneId = clean(input.zoneId) || config.zoneId;
    const explicitZoneName = clean(input.zoneName) || config.zoneName;
    let zone: { readonly id: string; readonly name: string } | undefined;
    if (explicitZoneId) {
      zone = { id: explicitZoneId, name: explicitZoneName || explicitZoneId };
    } else if (explicitZoneName) {
      zone = await resolveZone(client, {
        accountId,
        zoneId: input.zoneId,
        zoneName: input.zoneName,
        configuredZoneId: config.zoneId,
        configuredZoneName: config.zoneName,
        required: components.dns,
      });
    }
    const tokenApi = this.requireUserTokens(client);
    const permissionGroups = await resolvePermissionGroups(requirements, (params) => tokenApi.permissionGroups.list(params));
    const policies = buildTokenPolicies(accountId, zone?.id, permissionGroups);
    const tokenName = clean(input.tokenName) || 'GoodVibes Cloudflare Operational';
    const token = await tokenApi.create({
      name: tokenName,
      policies,
      ...(clean(input.expiresOn) ? { expires_on: clean(input.expiresOn) } : {}),
    });
    await verifyCreatedTokenPolicies(token, permissionGroups, tokenApi.get ? (tokenId) => tokenApi.get!(tokenId) : undefined);
    if (!token.value) {
      throw new CloudflareControlPlaneError('Cloudflare did not return a token value for the newly-created operational token.', 'CLOUDFLARE_TOKEN_VALUE_MISSING', 502);
    }

    let apiTokenRef: string | undefined;
    if (input.storeApiToken !== false) {
      await this.storeSecret(CLOUDFLARE_API_TOKEN_KEY, token.value);
      apiTokenRef = `goodvibes://secrets/goodvibes/${CLOUDFLARE_API_TOKEN_KEY}`;
      this.setConfig('cloudflare.apiTokenRef', apiTokenRef, persist);
      this.setConfig('cloudflare.accountId', accountId, persist);
      if (zone) {
        this.setConfig('cloudflare.zoneId', zone.id, persist);
        this.setConfig('cloudflare.zoneName', zone.name, persist);
      }
    }

    return {
      ok: true,
      ...(token.id ? { tokenId: token.id } : {}),
      tokenName,
      tokenSource: 'bootstrap',
      ...(apiTokenRef ? { apiTokenRef } : {}),
      ...(input.returnGeneratedToken ? { generatedToken: token.value } : {}),
      accountId,
      ...(zone ? { zoneId: zone.id } : {}),
      permissions: requirements,
    };
  }

  async discover(input: CloudflareDiscoverInput = {}): Promise<CloudflareDiscoverResult> {
    const apiToken = await this.resolveApiToken(input);
    if (!apiToken.value) {
      throw new CloudflareControlPlaneError(
        'Cloudflare API token is required. Set CLOUDFLARE_API_TOKEN, configure cloudflare.apiTokenRef, or pass apiToken.',
        'CLOUDFLARE_API_TOKEN_REQUIRED',
        400,
      );
    }
    const client = await this.createClient(apiToken.value);
    const config = this.readConfig();
    const warnings: string[] = [];
    const accounts = client.accounts.list
      ? await collectAsync(client.accounts.list())
      : await collectSingleAccount(client, clean(input.accountId) || config.accountId, warnings);
    const selectedAccountId = clean(input.accountId) || config.accountId || (accounts.length === 1 ? accounts[0]?.id ?? '' : '');
    const selectedAccount = selectedAccountId ? accounts.find((account) => account.id === selectedAccountId) ?? await client.accounts.get({ account_id: selectedAccountId }) : undefined;
    const zones = await discoverZones(client, {
      accountId: selectedAccount?.id ?? '',
      zoneName: input.zoneName,
      warnings,
    });
    const selectedZone = await selectDiscoveredZone(client, zones, {
      zoneId: input.zoneId,
      zoneName: input.zoneName,
      configuredZoneId: config.zoneId,
      configuredZoneName: config.zoneName,
      warnings,
    });

    let workerSubdomain: string | undefined;
    let queues: readonly CloudflareQueueLike[] | undefined;
    let kvNamespaces: readonly CloudflareKvNamespaceLike[] | undefined;
    let durableObjectNamespaces: readonly CloudflareDurableObjectNamespaceLike[] | undefined;
    let r2Buckets: readonly CloudflareR2BucketLike[] | undefined;
    let secretsStores: readonly CloudflareSecretsStoreLike[] | undefined;
    let tunnels: readonly CloudflareTunnelLike[] | undefined;
    let accessApplications: readonly CloudflareAccessApplicationLike[] | undefined;

    if (input.includeResources !== false && selectedAccount) {
      workerSubdomain = await tryDiscover('worker-subdomain', warnings, async () => (await client.workers.subdomains.get({ account_id: selectedAccount.id })).subdomain);
      queues = await tryDiscover('queues', warnings, async () => collectAsync(client.queues.list({ account_id: selectedAccount.id })));
      if (client.kv) kvNamespaces = await tryDiscover('kv-namespaces', warnings, async () => collectAsync(client.kv!.namespaces.list({ account_id: selectedAccount.id })));
      if (client.durableObjects) durableObjectNamespaces = await tryDiscover('durable-object-namespaces', warnings, async () => collectAsync(client.durableObjects!.namespaces.list({ account_id: selectedAccount.id })));
      if (client.r2) r2Buckets = await tryDiscover('r2-buckets', warnings, async () => (await client.r2!.buckets.list({ account_id: selectedAccount.id })).buckets ?? []);
      if (client.secretsStore) secretsStores = await tryDiscover('secrets-stores', warnings, async () => collectAsync(client.secretsStore!.stores.list({ account_id: selectedAccount.id })));
      if (client.zeroTrust?.tunnels) tunnels = await tryDiscover('zero-trust-tunnels', warnings, async () => collectAsync(client.zeroTrust!.tunnels!.cloudflared.list({ account_id: selectedAccount.id, is_deleted: false })));
      if (client.zeroTrust?.access) accessApplications = await tryDiscover('access-applications', warnings, async () => collectAsync(client.zeroTrust!.access!.applications.list({ account_id: selectedAccount.id })));
    } else if (!selectedAccount) {
      warnings.push('Select a Cloudflare account before discovering account-scoped resources.');
    }

    return {
      ok: true,
      tokenSource: apiToken.source,
      accounts,
      ...(selectedAccount ? { selectedAccount } : {}),
      zones,
      ...(selectedZone ? { selectedZone } : {}),
      ...(workerSubdomain ? { workerSubdomain } : {}),
      ...(queues ? { queues } : {}),
      ...(kvNamespaces ? { kvNamespaces } : {}),
      ...(durableObjectNamespaces ? { durableObjectNamespaces } : {}),
      ...(r2Buckets ? { r2Buckets } : {}),
      ...(secretsStores ? { secretsStores } : {}),
      ...(tunnels ? { tunnels } : {}),
      ...(accessApplications ? { accessApplications } : {}),
      warnings,
    };
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
    const config = this.readConfig();
    const components = resolveComponents(input.components);
    const accountId = this.resolveAccountId(input.accountId);
    const workerName = this.resolveWorkerName(input.workerName);
    const queueName = clean(input.queueName) || config.queueName || DEFAULT_QUEUE_NAME;
    const deadLetterQueueName = clean(input.deadLetterQueueName) || config.deadLetterQueueName || DEFAULT_DLQ_NAME;
    const daemonBaseUrl = stripTrailingSlash(clean(input.daemonBaseUrl) || config.daemonBaseUrl);
    const daemonHostname = clean(input.daemonHostname) || config.daemonHostname || hostnameFromUrl(daemonBaseUrl);
    const workerHostname = clean(input.workerHostname) || config.workerHostname;
    const workerCron = clean(input.workerCron) || config.workerCron || DEFAULT_WORKER_CRON;
    const queueJobPayloads = input.queueJobPayloads === true;

    if (components.workers && !daemonBaseUrl) {
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
    const resourceContext = this.createProvisioningContext();
    const account = await client.accounts.get({ account_id: accountId });
    steps.push({ name: 'validate-account', status: 'ok', message: `Validated Cloudflare account ${account.name}.`, resourceId: account.id });

    const zone = await resolveZone(client, {
      accountId,
      zoneId: input.zoneId,
      zoneName: input.zoneName,
      configuredZoneId: config.zoneId,
      configuredZoneName: config.zoneName,
      required: components.dns,
    });
    if (zone) {
      this.setConfig('cloudflare.zoneId', zone.id, persist);
      this.setConfig('cloudflare.zoneName', zone.name, persist);
      steps.push({ name: 'zone', status: 'ok', message: `Using Cloudflare zone ${zone.name}.`, resourceId: zone.id });
    } else if (components.dns) {
      steps.push({ name: 'zone', status: 'warning', message: 'No Cloudflare zone was selected; DNS hostname automation was skipped.' });
    }

    let deadLetterQueue: CloudflareQueueLike | undefined;
    let queue: CloudflareQueueLike | undefined;
    let deadLetterQueueId = '';
    let queueId = '';
    if (components.queues) {
      deadLetterQueue = await ensureQueue(client, accountId, deadLetterQueueName, steps, 'dead-letter-queue');
      queue = await ensureQueue(client, accountId, queueName, steps, 'queue');
      deadLetterQueueId = requireQueueId(deadLetterQueue, deadLetterQueueName);
      queueId = requireQueueId(queue, queueName);
    }

    const kv = components.kv ? await ensureKvNamespace(resourceContext, client, accountId, clean(input.kvNamespaceName) || config.kvNamespaceName || DEFAULT_KV_NAMESPACE_NAME, persist, steps) : undefined;
    const r2 = components.r2 ? await ensureR2Bucket(resourceContext, client, accountId, clean(input.r2BucketName) || config.r2BucketName || DEFAULT_R2_BUCKET_NAME, persist, steps) : undefined;
    const secretsStore = components.secretsStore ? await ensureSecretsStore(resourceContext, client, accountId, clean(input.secretsStoreName) || config.secretsStoreName || DEFAULT_SECRETS_STORE_NAME, persist, steps) : undefined;
    const tunnel = components.zeroTrustTunnel
      ? await ensureTunnel(resourceContext, client, {
        accountId,
        tunnelName: clean(input.tunnelName) || config.tunnelName || DEFAULT_TUNNEL_NAME,
        tunnelId: clean(input.tunnelId) || config.tunnelId,
        daemonHostname,
        tunnelServiceUrl: stripTrailingSlash(clean(input.tunnelServiceUrl) || daemonBaseUrl),
        persist,
        returnGeneratedSecrets: input.returnGeneratedSecrets === true,
        steps,
      })
      : undefined;

    let generatedWorkerClientToken: string | undefined;
    let effectiveWorkerClientToken = '';
    let subdomain = '';
    let workerBaseUrl = stripTrailingSlash(clean(input.workerBaseUrl) || config.workerBaseUrl);
    if (components.workers) {
      await uploadWorker(client, {
        accountId,
        workerName,
        queueName: components.queues ? queueName : '',
        daemonBaseUrl,
        queueJobPayloads,
        kvNamespaceId: kv?.id ?? '',
        r2BucketName: r2?.name ?? '',
        durableObject: components.durableObjects,
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
      effectiveWorkerClientToken = workerClientToken.value ?? '';
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

      subdomain = await configureWorkerSubdomain(resourceContext, client, {
        accountId,
        workerName,
        requestedSubdomain: input.workerSubdomain,
        enableWorkersDev: input.enableWorkersDev !== false,
        steps,
        persist,
      });
      const inferredWorkerBaseUrl = subdomain ? `https://${workerName}.${subdomain}.workers.dev` : '';
      workerBaseUrl = workerBaseUrl || inferredWorkerBaseUrl;
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
    }

    const consumer = components.queues && components.workers
      ? await ensureQueueConsumer(client, {
        accountId,
        queueId,
        workerName,
        deadLetterQueueName,
        steps,
      })
      : undefined;
    if (components.queues && !components.workers) {
      steps.push({ name: 'queue-consumer', status: 'warning', message: 'Cloudflare Queues were provisioned without a Worker consumer.' });
    }

    const durableObject = components.durableObjects
      ? await findDurableObjectNamespace(resourceContext, client, accountId, clean(input.durableObjectNamespaceName) || config.durableObjectNamespaceName || DEFAULT_DO_NAMESPACE_NAME, persist, steps)
      : undefined;

    const dnsRecords = await configureDns(client, {
      enabled: components.dns,
      zone,
      daemonHostname,
      tunnelId: tunnel?.id ?? '',
      workerHostname,
      workerBaseUrl,
      steps,
    });

    const access = components.zeroTrustAccess
      ? await ensureAccess(resourceContext, client, {
        accountId,
        daemonHostname,
        accessAppId: clean(input.accessAppId) || config.accessAppId,
        accessServiceTokenId: clean(input.accessServiceTokenId) || config.accessServiceTokenId,
        accessServiceTokenRef: clean(input.accessServiceTokenRef) || config.accessServiceTokenRef,
        persist,
        returnGeneratedSecrets: input.returnGeneratedSecrets === true,
        steps,
      })
      : undefined;

    this.setConfig('cloudflare.enabled', true, persist);
    this.setConfig('cloudflare.accountId', accountId, persist);
    if (components.workers) {
      this.setConfig('cloudflare.workerName', workerName, persist);
      this.setConfig('cloudflare.daemonBaseUrl', daemonBaseUrl, persist);
      if (daemonHostname) this.setConfig('cloudflare.daemonHostname', daemonHostname, persist);
      if (workerHostname) this.setConfig('cloudflare.workerHostname', workerHostname, persist);
      this.setConfig('cloudflare.workerCron', workerCron, persist);
    }
    if (components.queues) {
      this.setConfig('cloudflare.queueName', queueName, persist);
      this.setConfig('cloudflare.deadLetterQueueName', deadLetterQueueName, persist);
      this.setConfig('batch.queueBackend', 'cloudflare', persist);
    }
    if (input.batchMode) this.setConfig('batch.mode', input.batchMode, persist);

    const verification = components.workers && input.verify !== false && workerBaseUrl
      ? await this.verify({ workerBaseUrl, workerClientToken: effectiveWorkerClientToken })
      : undefined;
    if (verification) {
      steps.push({
        name: 'verify-worker',
        status: verification.ok ? 'ok' : 'warning',
        message: verification.ok ? 'Verified Worker health and daemon batch proxy.' : 'Worker verification completed with warnings.',
      });
    }

    const generatedSecrets = {
      ...(generatedWorkerClientToken && input.returnGeneratedSecrets ? { workerClientToken: generatedWorkerClientToken } : {}),
      ...(tunnel?.token && input.returnGeneratedSecrets ? { tunnelToken: tunnel.token } : {}),
      ...(access?.clientId && input.returnGeneratedSecrets ? { accessServiceTokenClientId: access.clientId } : {}),
      ...(access?.clientSecret && input.returnGeneratedSecrets ? { accessServiceTokenClientSecret: access.clientSecret } : {}),
    };

    return {
      ok: true,
      dryRun: false,
      steps,
      account: { id: account.id, name: account.name },
      ...(components.queues ? {
        queues: {
          queueName,
          queueId,
          deadLetterQueueName,
          deadLetterQueueId,
          ...(consumer?.consumer_id ? { consumerId: consumer.consumer_id } : {}),
        },
      } : {}),
      ...(components.workers ? {
        worker: {
          name: workerName,
          ...(workerBaseUrl ? { baseUrl: workerBaseUrl } : {}),
          ...(subdomain ? { subdomain } : {}),
          ...(workerHostname ? { hostname: workerHostname } : {}),
          ...(workerCron ? { cron: workerCron } : {}),
        },
      } : {}),
      ...(tunnel ? {
        tunnel: {
          id: tunnel.id,
          name: tunnel.name,
          ...(daemonHostname ? { hostname: daemonHostname } : {}),
          ...(tunnel.tokenRef ? { tokenRef: tunnel.tokenRef } : {}),
        },
      } : {}),
      ...(access ? {
        access: {
          ...(access.appId ? { appId: access.appId } : {}),
          ...(access.serviceTokenId ? { serviceTokenId: access.serviceTokenId } : {}),
          ...(access.serviceTokenRef ? { serviceTokenRef: access.serviceTokenRef } : {}),
        },
      } : {}),
      ...(dnsRecords.length > 0 && zone ? { dns: { zoneId: zone.id, zoneName: zone.name, records: dnsRecords } } : {}),
      ...(kv ? { kv: { namespaceName: kv.title ?? DEFAULT_KV_NAMESPACE_NAME, namespaceId: requireKvNamespaceId(kv) } } : {}),
      ...(durableObject ? { durableObjects: { namespaceName: durableObject.name ?? durableObject.class ?? DEFAULT_DO_NAMESPACE_NAME, ...(durableObject.id ? { namespaceId: durableObject.id } : {}) } } : {}),
      ...(r2 ? { r2: { bucketName: r2.name ?? DEFAULT_R2_BUCKET_NAME, storageClass: 'Standard' } } : {}),
      ...(secretsStore ? { secretsStore: { storeName: secretsStore.name, storeId: secretsStore.id } } : {}),
      ...(verification ? { verification } : {}),
      ...(Object.keys(generatedSecrets).length > 0 ? { generatedSecrets } : {}),
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
    return readCloudflareConfig(this.options.configManager);
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

  private requireUserTokens(client: CloudflareApiClient): NonNullable<CloudflareApiClient['user']>['tokens'] {
    if (!client.user?.tokens) {
      throw new CloudflareControlPlaneError('The Cloudflare client does not expose user token creation APIs.', 'CLOUDFLARE_TOKEN_API_UNAVAILABLE', 500);
    }
    return client.user.tokens;
  }

  private createProvisioningContext(): CloudflareProvisioningContext {
    return {
      readConfig: () => this.readConfig(),
      setConfig: (key, value, persist) => this.setConfig(key, value, persist),
      storeSecret: async (key, value) => await this.storeSecret(key, value),
    };
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

}
