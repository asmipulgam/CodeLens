import { apiFetch } from './client';
import type { QueryEvent } from './types';

/**
 * Server-Sent Events over a POST request. EventSource only supports GET, so the stream is
 * read from fetch() and parsed here. Each event's `data` is a JSON-encoded QueryEvent.
 */

export function splitSseBuffer(buffer: string): { blocks: string[]; rest: string } {
  // Hold back a trailing "\r" in case it is the first half of a "\r\n" split across chunks.
  const holdBack = buffer.endsWith('\r') ? '\r' : '';
  const body = holdBack ? buffer.slice(0, -1) : buffer;
  const normalized = body.replace(/\r\n?/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = (parts.pop() ?? '') + holdBack;
  return { blocks: parts.filter((part) => part.trim().length > 0), rest };
}

export function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

const EVENT_TYPES = new Set(['started', 'progress', 'clarification', 'confirmation', 'result', 'error']);

export function toQueryEvent(data: string): QueryEvent | null {
  try {
    const parsed = JSON.parse(data) as { type?: unknown };
    return typeof parsed.type === 'string' && EVENT_TYPES.has(parsed.type) ? (parsed as QueryEvent) : null;
  } catch {
    return null;
  }
}

export async function* streamQueryEvents(
  path: string,
  body: unknown,
  signal: AbortSignal,
): AsyncGenerator<QueryEvent> {
  const response = await apiFetch(path, {
    method: 'POST',
    json: body,
    signal,
    headers: { Accept: 'text/event-stream' },
  });
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { blocks, rest } = splitSseBuffer(buffer);
      buffer = rest;
      for (const block of blocks) {
        const parsed = parseSseBlock(block);
        const event = parsed && toQueryEvent(parsed.data);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    const { blocks } = splitSseBuffer(`${buffer}\n\n`);
    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      const event = parsed && toQueryEvent(parsed.data);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}
