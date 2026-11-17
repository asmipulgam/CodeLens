const DEFAULT_PATH = '/ask';

/**
 * Only same-site relative paths are allowed as post-login destinations, which prevents
 * open-redirect attacks such as ?returnTo=https://evil.example or //evil.example.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value) return DEFAULT_PATH;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return DEFAULT_PATH;
  if ([...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) return DEFAULT_PATH;
  try {
    const parsed = new URL(value, 'https://codelens.invalid');
    if (parsed.origin !== 'https://codelens.invalid') return DEFAULT_PATH;
    if (parsed.pathname === '/login' || parsed.pathname.startsWith('/api/')) return DEFAULT_PATH;
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return DEFAULT_PATH;
  }
}
