import { createHash, createHmac } from 'node:crypto';
import { constantTimeEquals, parseJsonRecord, readBearerOrHeaderToken, readTextBodyWithinLimit } from '../helpers.js';
import type { SurfaceAdapterContext } from '../types.js';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseTelephonyBody(req: Request, rawBody: string): Record<string, unknown> | Response {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return parseJsonRecord(rawBody);
  }
  const params = new URLSearchParams(rawBody);
  const parsed: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) parsed[key] = value;
  return parsed;
}

function signatureCandidateUrls(req: Request, context: SurfaceAdapterContext): readonly string[] {
  const requestUrl = new URL(req.url);
  const candidates = [requestUrl.toString()];
  const publicBaseUrl =
    readString(context.configManager.get('web.publicBaseUrl'))
    ?? readString(context.configManager.get('controlPlane.baseUrl'));
  if (publicBaseUrl) {
    candidates.push(new URL(`${requestUrl.pathname}${requestUrl.search}`, publicBaseUrl.endsWith('/') ? publicBaseUrl : `${publicBaseUrl}/`).toString());
  }
  return [...new Set(candidates)];
}

function twilioSignatureBaseString(url: string, rawBody: string, req: Request): string | null {
  const parsedUrl = new URL(url);
  const bodyHash = parsedUrl.searchParams.get('bodySHA256');
  if (bodyHash) {
    const expectedHash = createHash('sha256').update(rawBody).digest('hex');
    if (!constantTimeEquals(expectedHash, bodyHash.toLowerCase())) return null;
    return url;
  }
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return null;
  const params = [...new URLSearchParams(rawBody).entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  return `${url}${params.map(([key, value]) => `${key}${value}`).join('')}`;
}

function verifyTwilioSignature(
  req: Request,
  rawBody: string,
  context: SurfaceAdapterContext,
  authToken: string,
  signature: string,
): boolean {
  if (!authToken || !signature) return false;
  for (const url of signatureCandidateUrls(req, context)) {
    const baseString = twilioSignatureBaseString(url, rawBody, req);
    if (!baseString) continue;
    const expected = createHmac('sha1', authToken).update(baseString).digest('base64');
    if (constantTimeEquals(expected, signature)) return true;
  }
  return false;
}

export async function handleTelephonySurfaceWebhook(req: Request, context: SurfaceAdapterContext): Promise<Response> {
  const configuredSecret =
    String(context.configManager.get('surfaces.telephony.webhookSecret') ?? '')
    || await context.serviceRegistry.resolveSecret('telephony', 'signingSecret')
    || String(context.configManager.get('surfaces.telephony.token') ?? '')
    || await context.serviceRegistry.resolveSecret('telephony', 'primary')
    || process.env.TELEPHONY_WEBHOOK_SECRET
    || process.env.TWILIO_WEBHOOK_SECRET
    || process.env.TELEPHONY_BRIDGE_TOKEN
    || '';
  const twilioAuthToken =
    await context.serviceRegistry.resolveSecret('telephony', 'authToken')
    || String(context.configManager.get('surfaces.telephony.authToken') ?? '')
    || process.env.TWILIO_AUTH_TOKEN
    || '';
  if (!configuredSecret && !twilioAuthToken) {
    return Response.json({ error: 'Telephony webhook is not configured' }, { status: 503 });
  }

  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  const providedToken = readBearerOrHeaderToken(req, 'x-goodvibes-telephony-token');
  const providedTwilioSignature = readString(req.headers.get('x-twilio-signature')) ?? '';
  const sharedSecretAllowed = configuredSecret ? constantTimeEquals(configuredSecret, providedToken) : false;
  const twilioSignatureAllowed = verifyTwilioSignature(req, rawBody, context, twilioAuthToken, providedTwilioSignature);
  if (!sharedSecretAllowed && !twilioSignatureAllowed) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = parseTelephonyBody(req, rawBody);
  if (parsed instanceof Response) return parsed;
  const payload = readRecord(parsed);
  if (!payload) return Response.json({ error: 'Invalid request body' }, { status: 400 });

  const from = readString(payload.from) ?? readString(payload.From) ?? readString(payload.caller) ?? readString(payload.Caller) ?? readString(payload.source);
  const to = readString(payload.to) ?? readString(payload.To) ?? readString(context.configManager.get('surfaces.telephony.fromNumber')) ?? 'telephony';
  const text =
    readString(payload.text)
    ?? readString(payload.message)
    ?? readString(payload.Body)
    ?? readString(payload.body)
    ?? readString(payload.SpeechResult)
    ?? readString(payload.transcription)
    ?? '';
  if (!from) return Response.json({ error: 'Missing telephony sender' }, { status: 400 });

  const messageId = readString(payload.messageId) ?? readString(payload.MessageSid) ?? readString(payload.SmsSid) ?? readString(payload.CallSid);
  const policy = await context.authorizeSurfaceIngress({
    surface: 'telephony',
    userId: from,
    channelId: from,
    groupId: from,
    conversationKind: 'direct',
    text,
    mentioned: true,
    metadata: {
      ...payload,
      messageId,
      to,
    },
  });
  if (!policy.allowed) {
    return Response.json({ error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
  }

  const binding = await context.routeBindings.upsertBinding({
    kind: 'channel',
    surfaceKind: 'telephony',
    surfaceId: to,
    externalId: from,
    channelId: from,
    title: from,
    metadata: {
      ...payload,
      messageId,
      to,
    },
  });
  if (!text) {
    return Response.json({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'no-actionable-text',
      bindingId: binding.id,
    });
  }

  const submission = await context.sessionBroker.submitMessage({
    routeId: binding.id,
    surfaceKind: 'telephony',
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    threadId: binding.channelId,
    userId: from,
    displayName: from,
    title: from,
    body: text,
    metadata: {
      messageId,
      to,
    },
  });
  if (submission.mode === 'continued-live') {
    return Response.json({ acknowledged: true, continued: true, sessionId: submission.session.id, agentId: submission.activeAgentId ?? null });
  }

  const spawnResult = context.trySpawnAgent(
    { mode: 'spawn', task: submission.task! },
    'handleTelephonySurfaceWebhook',
    submission.session.id,
  );
  if (spawnResult instanceof Response) return spawnResult;
  await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
  context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
    agentId: spawnResult.id,
    task: text,
    sessionId: submission.session.id,
  });
  return Response.json({ acknowledged: true, queued: true, bindingId: binding.id, sessionId: submission.session.id, agentId: spawnResult.id });
}
