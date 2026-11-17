/**
 * Browser storage is used ONLY for harmless UI preferences (theme, sidebar state).
 * Never store tokens, query results, conversations or anything from the database here.
 */
const PREFIX = 'codelens.';

export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // Storage can be unavailable (private mode, blocked). Preferences are optional.
  }
}
