/**
 * Spreadsheet-safe CSV/TSV encoding.
 *
 * Cells beginning with = + - @ (or tab / carriage return) are interpreted as formulas by
 * Excel and Google Sheets, which lets malicious database content run commands or leak data
 * when an export is opened ("CSV injection"). Such cells are prefixed with a single quote.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function neutralizeFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Real numbers and booleans are safe as-is (e.g. -42); only text can smuggle in a formula. */
function safeText(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return neutralizeFormula(stringify(value));
}

export function csvCell(value: unknown): string {
  const text = safeText(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function tsvCell(value: unknown): string {
  return safeText(value).replace(/[\t\r\n]+/g, ' ');
}

export function toTsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((row) => row.map(tsvCell).join('\t')).join('\n');
}
