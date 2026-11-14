/**
 * POST /api/assistant/chat → text/event-stream.
 *
 * Events (each `data:` is one JSON object):
 *   event: open   data: {}                            stream accepted; Claude is thinking
 *   event: delta  data: {"text": "..."}               streamed answer text
 *   event: done   data: {"stopReason": "...", "note": "..."|null}
 *   event: error  data: {"message": "..."}            failure after the stream opened
 * Validation errors and a missing API key are reported before streaming as JSON
 * {"error": "..."} with HTTP 400. The upstream Claude request is aborted when the client
 * disconnects. A comment heartbeat keeps the connection alive during long thinking pauses.
 */
import type { ServerResponse } from 'node:http';
import { describeAssistantError, validateChatMessages, type Assistant } from './service.ts';

const HEARTBEAT_MS = 15_000;

function jsonError(res: ServerResponse, message: string): void {
  res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: message }));
}

export async function serveAssistantChat(assistant: Assistant, body: unknown, res: ServerResponse): Promise<void> {
  const messages = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).messages : undefined;
  try { validateChatMessages(messages); }
  catch (error) { jsonError(res, describeAssistantError(error)); return; }
  if (!assistant.status().configured) { jsonError(res, 'Add your Claude API key in Settings to use the assistant.'); return; }

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event: string, data: unknown) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('open', {});
  const heartbeat = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n'); }, HEARTBEAT_MS);
  try {
    const result = await assistant.chat(messages, text => send('delta', { text }), controller.signal);
    if (!controller.signal.aborted) send('done', result);
  } catch (error) {
    if (!controller.signal.aborted) send('error', { message: describeAssistantError(error) });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}
