export const DEFAULT_MAX_REQUEST_BODY_BYTES = 1_000_000;

function ignoreCancelError(): void {
  // Best-effort stream cancellation.
}

export async function readTextBodyWithinLimit(
  req: Request,
  maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<string | Response> {
  const contentLength = Number.parseInt(req.headers.get('content-length') ?? '0', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }

  if (!req.body) return '';
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('Payload too large').catch(ignoreCancelError);
        return Response.json({ error: 'Payload too large' }, { status: 413 });
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

export async function readJsonBodyWithinLimit(
  req: Request,
  maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<unknown | Response> {
  const raw = await readTextBodyWithinLimit(req, maxBytes);
  if (raw instanceof Response) return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}
