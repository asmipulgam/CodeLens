/** Saves a Blob as a file and releases the object URL immediately afterwards. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Reads `filename="..."` from a Content-Disposition header, keeping only safe characters. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  const match = header?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const raw = match ? decodeURIComponent(match[1]) : fallback;
  const safe = raw.replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  return safe || fallback;
}
