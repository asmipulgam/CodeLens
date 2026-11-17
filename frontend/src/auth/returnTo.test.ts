import { describe, expect, it } from 'vitest';
import { safeReturnTo } from './returnTo';

describe('safeReturnTo (open-redirect protection)', () => {
  it('keeps same-site paths with query and hash', () => {
    expect(safeReturnTo('/ask/c-123?x=1#top')).toBe('/ask/c-123?x=1#top');
    expect(safeReturnTo('/admin/sources')).toBe('/admin/sources');
  });

  it.each([
    'https://evil.example',
    '//evil.example/path',
    '/\\evil.example',
    'javascript:alert(1)',
    'ask',
    '/login',
    '/api/auth/login',
    '/ask\n/evil',
    '',
    null,
    undefined,
  ])('falls back to /ask for %j', (value) => {
    expect(safeReturnTo(value)).toBe('/ask');
  });
});
