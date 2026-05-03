import { ContractError, GoodVibesSdkError } from '@pellux/goodvibes-errors';
import type { OperatorContractManifest, OperatorMethodContract } from '@pellux/goodvibes-contracts';
import type {
  OperatorMethodInput,
  OperatorMethodOutput,
  OperatorStreamMethodId,
  OperatorTypedMethodId,
} from '@pellux/goodvibes-contracts';
import type { HttpTransport } from '@pellux/goodvibes-transport-http';
import {
  invokeContractRoute,
  firstJsonSchemaFailure,
  openContractRouteStream,
  requireContractRoute,
  clientInputRecord,
  type ContractRouteDefinition,
  type ContractRouteLike,
  type ContractInvokeOptions,
  type ContractStreamOptions,
  mergeClientInput,
  splitClientArgs,
  type MethodArgs,
  type WithoutKeys,
} from '@pellux/goodvibes-transport-http';

export interface OperatorRemoteClientInvokeOptions extends ContractInvokeOptions {}

export interface OperatorRemoteClientStreamOptions extends ContractStreamOptions {}

export interface OperatorRemoteClientOptions {
  readonly getResponseSchema?: (methodId: string) => ContractInvokeOptions['responseSchema'];
  readonly validateResponses?: boolean;
}

type KnownMethodArgs<TMethodId extends OperatorTypedMethodId> = MethodArgs<
  OperatorMethodInput<TMethodId>,
  OperatorRemoteClientInvokeOptions
>;

type KnownPathMethodArgs<
  TMethodId extends OperatorTypedMethodId,
  TKeys extends PropertyKey,
> = MethodArgs<
  WithoutKeys<OperatorMethodInput<TMethodId>, TKeys>,
  OperatorRemoteClientInvokeOptions
>;

type KnownStreamArgs<TMethodId extends OperatorStreamMethodId> = MethodArgs<
  OperatorMethodInput<TMethodId>,
  OperatorRemoteClientStreamOptions
>;

export interface OperatorRemoteClient {
  readonly transport: HttpTransport;
  readonly contract: OperatorContractManifest;
  listOperations(): readonly OperatorMethodContract[];
  getOperation(methodId: string): OperatorMethodContract;
  invoke<TMethodId extends OperatorTypedMethodId>(
    methodId: TMethodId,
    ...args: KnownMethodArgs<TMethodId>
  ): Promise<OperatorMethodOutput<TMethodId>>;
  invoke<T = unknown>(
    methodId: string,
    input?: Record<string, unknown>,
    options?: OperatorRemoteClientInvokeOptions,
  ): Promise<T>;
  stream<TMethodId extends OperatorStreamMethodId>(
    methodId: TMethodId,
    ...args: KnownStreamArgs<TMethodId>
  ): Promise<() => void>;
  readonly sessions: {
    create(...args: KnownMethodArgs<'sessions.create'>): Promise<OperatorMethodOutput<'sessions.create'>>;
    get(sessionId: string, ...args: KnownPathMethodArgs<'sessions.get', 'sessionId'>): Promise<OperatorMethodOutput<'sessions.get'>>;
    list(...args: KnownMethodArgs<'sessions.list'>): Promise<OperatorMethodOutput<'sessions.list'>>;
    messages: {
      create(sessionId: string, ...args: KnownPathMethodArgs<'sessions.messages.create', 'sessionId'>): Promise<OperatorMethodOutput<'sessions.messages.create'>>;
      list(sessionId: string, ...args: KnownPathMethodArgs<'sessions.messages.list', 'sessionId'>): Promise<OperatorMethodOutput<'sessions.messages.list'>>;
    };
    inputs: {
      cancel(sessionId: string, inputId: string, ...args: KnownPathMethodArgs<'sessions.inputs.cancel', 'sessionId' | 'inputId'>): Promise<OperatorMethodOutput<'sessions.inputs.cancel'>>;
    };
    followUp(...args: KnownMethodArgs<'sessions.followUp'>): Promise<OperatorMethodOutput<'sessions.followUp'>>;
    steer(...args: KnownMethodArgs<'sessions.steer'>): Promise<OperatorMethodOutput<'sessions.steer'>>;
    close(sessionId: string, ...args: KnownPathMethodArgs<'sessions.close', 'sessionId'>): Promise<OperatorMethodOutput<'sessions.close'>>;
    reopen(sessionId: string, ...args: KnownPathMethodArgs<'sessions.reopen', 'sessionId'>): Promise<OperatorMethodOutput<'sessions.reopen'>>;
  };
  readonly tasks: {
    create(...args: KnownMethodArgs<'tasks.create'>): Promise<OperatorMethodOutput<'tasks.create'>>;
    get(taskId: string, ...args: KnownPathMethodArgs<'tasks.get', 'taskId'>): Promise<OperatorMethodOutput<'tasks.get'>>;
    list(...args: KnownMethodArgs<'tasks.list'>): Promise<OperatorMethodOutput<'tasks.list'>>;
    status(...args: KnownMethodArgs<'tasks.status'>): Promise<OperatorMethodOutput<'tasks.status'>>;
    cancel(taskId: string, ...args: KnownPathMethodArgs<'tasks.cancel', 'taskId'>): Promise<OperatorMethodOutput<'tasks.cancel'>>;
    retry(taskId: string, ...args: KnownPathMethodArgs<'tasks.retry', 'taskId'>): Promise<OperatorMethodOutput<'tasks.retry'>>;
  };
  readonly approvals: {
    list(...args: KnownMethodArgs<'approvals.list'>): Promise<OperatorMethodOutput<'approvals.list'>>;
    claim(approvalId: string, ...args: KnownPathMethodArgs<'approvals.claim', 'approvalId'>): Promise<OperatorMethodOutput<'approvals.claim'>>;
    approve(approvalId: string, ...args: KnownPathMethodArgs<'approvals.approve', 'approvalId'>): Promise<OperatorMethodOutput<'approvals.approve'>>;
    deny(approvalId: string, ...args: KnownPathMethodArgs<'approvals.deny', 'approvalId'>): Promise<OperatorMethodOutput<'approvals.deny'>>;
    cancel(approvalId: string, ...args: KnownPathMethodArgs<'approvals.cancel', 'approvalId'>): Promise<OperatorMethodOutput<'approvals.cancel'>>;
  };
  readonly providers: {
    list(...args: KnownMethodArgs<'providers.list'>): Promise<OperatorMethodOutput<'providers.list'>>;
    get(providerId: string, ...args: KnownPathMethodArgs<'providers.get', 'providerId'>): Promise<OperatorMethodOutput<'providers.get'>>;
    usage(providerId: string, ...args: KnownPathMethodArgs<'providers.usage.get', 'providerId'>): Promise<OperatorMethodOutput<'providers.usage.get'>>;
  };
  readonly accounts: {
    snapshot(...args: KnownMethodArgs<'accounts.snapshot'>): Promise<OperatorMethodOutput<'accounts.snapshot'>>;
  };
  readonly localAuth: {
    status(...args: KnownMethodArgs<'local_auth.status'>): Promise<OperatorMethodOutput<'local_auth.status'>>;
  };
  readonly control: {
    snapshot(...args: KnownMethodArgs<'control.snapshot'>): Promise<OperatorMethodOutput<'control.snapshot'>>;
    status(...args: KnownMethodArgs<'control.status'>): Promise<OperatorMethodOutput<'control.status'>>;
    contract(...args: KnownMethodArgs<'control.contract'>): Promise<OperatorMethodOutput<'control.contract'>>;
    methods: {
      list(...args: KnownMethodArgs<'control.methods.list'>): Promise<OperatorMethodOutput<'control.methods.list'>>;
      get(methodId: string, ...args: KnownPathMethodArgs<'control.methods.get', 'methodId'>): Promise<OperatorMethodOutput<'control.methods.get'>>;
    };
    auth: {
      current(...args: KnownMethodArgs<'control.auth.current'>): Promise<OperatorMethodOutput<'control.auth.current'>>;
      login(...args: KnownMethodArgs<'control.auth.login'>): Promise<OperatorMethodOutput<'control.auth.login'>>;
    };
    events: {
      catalog(...args: KnownMethodArgs<'control.events.catalog'>): Promise<OperatorMethodOutput<'control.events.catalog'>>;
      stream(...args: KnownStreamArgs<'control.events.stream'>): Promise<() => void>;
    };
  };
  readonly telemetry: {
    snapshot(...args: KnownMethodArgs<'telemetry.snapshot'>): Promise<OperatorMethodOutput<'telemetry.snapshot'>>;
    events(...args: KnownMethodArgs<'telemetry.events.list'>): Promise<OperatorMethodOutput<'telemetry.events.list'>>;
    errors(...args: KnownMethodArgs<'telemetry.errors.list'>): Promise<OperatorMethodOutput<'telemetry.errors.list'>>;
    traces(...args: KnownMethodArgs<'telemetry.traces.list'>): Promise<OperatorMethodOutput<'telemetry.traces.list'>>;
    metrics(...args: KnownMethodArgs<'telemetry.metrics.get'>): Promise<OperatorMethodOutput<'telemetry.metrics.get'>>;
    otlp: {
      traces(...args: KnownMethodArgs<'telemetry.otlp.traces'>): Promise<OperatorMethodOutput<'telemetry.otlp.traces'>>;
      logs(...args: KnownMethodArgs<'telemetry.otlp.logs'>): Promise<OperatorMethodOutput<'telemetry.otlp.logs'>>;
      metrics(...args: KnownMethodArgs<'telemetry.otlp.metrics'>): Promise<OperatorMethodOutput<'telemetry.otlp.metrics'>>;
    };
    stream(...args: KnownStreamArgs<'telemetry.stream'>): Promise<() => void>;
  };
}

function requireMethod(
  contract: OperatorContractManifest,
  methodId: string,
): OperatorMethodContract {
  return requireContractRoute(contract.operator.methods, methodId, 'operator method');
}

function requireMethodRoute(
  contract: OperatorContractManifest,
  methodId: string,
): ContractRouteDefinition & ContractRouteLike {
  const method = requireMethod(contract, methodId);
  return methodHttpRoute(method);
}

function methodHttpRoute(method: OperatorMethodContract): ContractRouteDefinition & ContractRouteLike {
  if (!method.http) {
    throw new GoodVibesSdkError(`Operator method "${method.id}" does not expose an HTTP binding. This method may be internal-only or require a different transport. Check the contract manifest for available HTTP methods.`, { category: 'contract', source: 'contract', recoverable: false });
  }
  return {
    ...method.http,
    id: method.id,
    idempotent: method.idempotent,
  };
}

export function createOperatorRemoteClient(
  transport: HttpTransport,
  contract: OperatorContractManifest,
  clientOptions: OperatorRemoteClientOptions = {},
): OperatorRemoteClient {
  function invokeTyped<TMethodId extends OperatorTypedMethodId>(
    methodId: TMethodId,
    ...args: KnownMethodArgs<TMethodId>
  ): Promise<OperatorMethodOutput<TMethodId>>;
  function invokeTyped<T = unknown>(
    methodId: string,
    input?: Record<string, unknown>,
    options?: OperatorRemoteClientInvokeOptions,
  ): Promise<T>;
  function invokeTyped<T = unknown>(
    methodId: string,
    input?: Record<string, unknown>,
    options: OperatorRemoteClientInvokeOptions = {},
  ): Promise<T> {
    const schema = options.responseSchema ?? clientOptions.getResponseSchema?.(methodId);
    const method = requireMethod(contract, methodId);
    const route = methodHttpRoute(method);
    return invokeContractRoute<T>(
      transport,
      route,
      input,
      schema ? { ...options, responseSchema: schema } : options,
    ).then((body) => {
      if (!schema && clientOptions.validateResponses !== false) validateJsonSchemaResponse(method, body);
      return body;
    });
  }

  function streamTyped<TMethodId extends OperatorStreamMethodId>(
    methodId: TMethodId,
    ...args: KnownStreamArgs<TMethodId>
  ): Promise<() => void> {
    const [input, options] = splitClientArgs<OperatorMethodInput<TMethodId>, OperatorRemoteClientStreamOptions>(args);
    // Streams may be opened without handlers when the caller wants the raw
    // cancel function only; provide the empty handler map explicitly so
    // openContractRouteStream never has to infer a missing options object.
    const streamOptions = options ?? { handlers: {} };
    return openContractRouteStream(
      transport,
      requireMethodRoute(contract, methodId),
      clientInputRecord(input),
      streamOptions,
    );
  }

  const client: OperatorRemoteClient = {
    transport,
    contract,
    listOperations(): readonly OperatorMethodContract[] {
      return contract.operator.methods;
    },
    getOperation(methodId: string): OperatorMethodContract {
      return requireMethod(contract, methodId);
    },
    invoke: invokeTyped,
    stream: streamTyped,
    sessions: {
      create: (...args) => invokeTyped('sessions.create', ...args),
      get: (sessionId, ...args) => {
        const [input, options] = splitClientArgs<WithoutKeys<OperatorMethodInput<'sessions.get'>, 'sessionId'>, OperatorRemoteClientInvokeOptions>(args);
        return invokeTyped('sessions.get', mergeClientInput({ sessionId }, input), options);
      },
      list: (...args) => invokeTyped('sessions.list', ...args),
      messages: {
        create: (sessionId, ...args) => {
          const [input, options] = splitClientArgs<WithoutKeys<OperatorMethodInput<'sessions.messages.create'>, 'sessionId'>, OperatorRemoteClientInvokeOptions>(args);
          return invokeTyped('sessions.messages.create', mergeClientInput({ sessionId }, input), options);
        },
        list: (sessionId, ...args) => {
          const [input, options] = splitClientArgs<WithoutKeys<OperatorMethodInput<'sessions.messages.list'>, 'sessionId'>, OperatorRemoteClientInvokeOptions>(args);
          return invokeTyped('sessions.messages.list', mergeClientInput({ sessionId }, input), options);
        },
      },
      inputs: {
        cancel: (sessionId, inputId, ...args) => {
          const [input, options] = splitClientArgs<WithoutKeys<OperatorMethodInput<'sessions.inputs.cancel'>, 'sessionId' | 'inputId'>, OperatorRemoteClientInvokeOptions>(args);
          return invokeTyped('sessions.inputs.cancel', mergeClientInput({
            sessionId,
            inputId,
          }, input), options);
        },
      },
      followUp: (...args) => invokeTyped('sessions.followUp', ...args),
      steer: (...args) => invokeTyped('sessions.steer', ...args),
      close: (sessionId, ...args) => {
        const [input, options] = splitClientArgs<WithoutKeys<OperatorMethodInput<'sessions.close'>, 'sessionId'>, OperatorRemoteClientInvokeOptions>(args);
        return invokeTyped('sessions.close', mergeClientInput({ sessionId }, input), options);
      },
      reopen: (sessionId, ...args) => {
        const [input, options] = splitClientArgs<WithoutKeys<OperatorMethodInput<'sessions.reopen'>, 'sessionId'>, OperatorRemoteClientInvokeOptions>(args);
        return invokeTyped('sessions.reopen', mergeClientInput({ sessionId }, input), options);
      },
    },
    tasks: {
      create: (...args) => invokeTyped('tasks.create', ...args),
      get: (taskId, ...args) => {
        const [input, options] = splitClientArgs<WithoutKeys<OperatorMethodInput<'tasks.get'>, 'taskId'>, OperatorRemoteClientInvokeOptions>(args);
        return invokeTyped('tasks.get', mergeClientInput({ taskId }, input), options);
      },
      list: (...args) => invokeTyped('tasks.list', ...args),
      status: (...args) => invokeTyped('tasks.status', ...args),
      cancel: (taskId, ...args) => {
        const [input, options] = splitClientArgs<WithoutKeys<OperatorMethodInput<'tasks.cancel'>, 'taskId'>, OperatorRemoteClientInvokeOptions>(args);
        return invokeTyped('tasks.cancel', mergeClientInput({ taskId }, input), options);
      },
      retry: (taskId, ...args) => {
        const [input, options] = splitClientArgs<WithoutKeys<OperatorMethodInput<'tasks.retry'>, 'taskId'>, OperatorRemoteClientInvokeOptions>(args);
        return invokeTyped('tasks.retry', mergeClientInput({ taskId }, input), options);
      },
    },
    approvals: {
      list: (...args) => invokeTyped('approvals.list', ...args),
      claim: (approvalId, ...args) => {
        const [input, options] = splitClientArgs<WithoutKeys<OperatorMethodInput<'approvals.claim'>, 'approvalId'>, OperatorRemoteClientInvokeOptions>(args);
        return invokeTyped('approvals.claim', mergeClientInput({ approvalId }, input), options);
      },
      approve: (approvalId, ...args) => {
        const [input, options] = splitClientArgs<WithoutKeys<OperatorMethodInput<'approvals.approve'>, 'approvalId'>, OperatorRemoteClientInvokeOptions>(args);
        return invokeTyped('approvals.approve', mergeClientInput({ approvalId }, input), options);
      },
      deny: (approvalId, ...args) => {
        const [input, options] = splitClientArgs<WithoutKeys<OperatorMethodInput<'approvals.deny'>, 'approvalId'>, OperatorRemoteClientInvokeOptions>(args);
        return invokeTyped('approvals.deny', mergeClientInput({ approvalId }, input), options);
      },
      cancel: (approvalId, ...args) => {
        const [input, options] = splitClientArgs<WithoutKeys<OperatorMethodInput<'approvals.cancel'>, 'approvalId'>, OperatorRemoteClientInvokeOptions>(args);
        return invokeTyped('approvals.cancel', mergeClientInput({ approvalId }, input), options);
      },
    },
    providers: {
      list: (...args) => invokeTyped('providers.list', ...args),
      get: (providerId, ...args) => {
        const [input, options] = splitClientArgs<WithoutKeys<OperatorMethodInput<'providers.get'>, 'providerId'>, OperatorRemoteClientInvokeOptions>(args);
        return invokeTyped('providers.get', mergeClientInput({ providerId }, input), options);
      },
      usage: (providerId, ...args) => {
        const [input, options] = splitClientArgs<WithoutKeys<OperatorMethodInput<'providers.usage.get'>, 'providerId'>, OperatorRemoteClientInvokeOptions>(args);
        return invokeTyped('providers.usage.get', mergeClientInput({ providerId }, input), options);
      },
    },
    accounts: {
      snapshot: (...args) => invokeTyped('accounts.snapshot', ...args),
    },
    localAuth: {
      status: (...args) => invokeTyped('local_auth.status', ...args),
    },
    control: {
      snapshot: (...args) => invokeTyped('control.snapshot', ...args),
      status: (...args) => invokeTyped('control.status', ...args),
      contract: (...args) => invokeTyped('control.contract', ...args),
      methods: {
        list: (...args) => invokeTyped('control.methods.list', ...args),
        get: (methodId, ...args) => {
          const [input, options] = splitClientArgs<WithoutKeys<OperatorMethodInput<'control.methods.get'>, 'methodId'>, OperatorRemoteClientInvokeOptions>(args);
          return invokeTyped('control.methods.get', mergeClientInput({ methodId }, input), options);
        },
      },
      auth: {
        current: (...args) => invokeTyped('control.auth.current', ...args),
        login: (...args) => invokeTyped('control.auth.login', ...args),
      },
      events: {
        catalog: (...args) => invokeTyped('control.events.catalog', ...args),
        stream: (...args) => streamTyped('control.events.stream', ...args),
      },
    },
    telemetry: {
      snapshot: (...args) => invokeTyped('telemetry.snapshot', ...args),
      events: (...args) => invokeTyped('telemetry.events.list', ...args),
      errors: (...args) => invokeTyped('telemetry.errors.list', ...args),
      traces: (...args) => invokeTyped('telemetry.traces.list', ...args),
      metrics: (...args) => invokeTyped('telemetry.metrics.get', ...args),
      otlp: {
        traces: (...args) => invokeTyped('telemetry.otlp.traces', ...args),
        logs: (...args) => invokeTyped('telemetry.otlp.logs', ...args),
        metrics: (...args) => invokeTyped('telemetry.otlp.metrics', ...args),
      },
      stream: (...args) => streamTyped('telemetry.stream', ...args),
    },
  };

  return client;
}

function validateJsonSchemaResponse(method: OperatorMethodContract, body: unknown): void {
  const schema = method.outputSchema;
  if (!schema || typeof schema !== 'object') return;
  const failure = firstJsonSchemaFailure(schema as Record<string, unknown>, body);
  if (!failure) return;
  throw new ContractError(
    `Response validation failed for operator method "${method.id}": field "${failure.path}" expected ${failure.expected} but received ${failure.received}. Ensure the daemon is running the matching GoodVibes contract version.`,
    { source: 'contract' },
  );
}
