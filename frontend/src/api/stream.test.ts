import { describe, expect, it } from 'vitest';
import { parseSseBlock, splitSseBuffer, toQueryEvent } from './stream';

describe('SSE parsing', () => {
  it('splits complete events and keeps the remainder', () => {
    const { blocks, rest } = splitSseBuffer('event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\nda');
    expect(blocks).toEqual(['event: a\ndata: 1', 'event: b\ndata: 2']);
    expect(rest).toBe('event: c\nda');
  });

  it('handles CRLF line endings, including a CRLF split across chunks', () => {
    const first = splitSseBuffer('data: 1\r\n\r');
    expect(first.blocks).toEqual([]);
    const second = splitSseBuffer(`${first.rest}\ndata: 2\r\n\r\n`);
    expect(second.blocks).toEqual(['data: 1', 'data: 2']);
  });

  it('joins multi-line data and ignores comments', () => {
    expect(parseSseBlock(': keep-alive\nevent: result\ndata: {"a":\ndata: 1}')).toEqual({
      event: 'result',
      data: '{"a":\n1}',
    });
    expect(parseSseBlock(': only a comment')).toBeNull();
  });

  it('accepts only known event types', () => {
    expect(toQueryEvent('{"type":"progress","stage":"running"}')).toEqual({ type: 'progress', stage: 'running' });
    expect(toQueryEvent('{"type":"evil"}')).toBeNull();
    expect(toQueryEvent('not json')).toBeNull();
  });
});
