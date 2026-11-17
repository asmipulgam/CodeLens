const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? integer.format(value) : decimal.format(value);
}

/** Axis-style compact numbers: full below 10,000, then 12K / 4.2M. */
export function formatCompact(value: number): string {
  return Math.abs(value) < 10_000 ? integer.format(value) : compact.format(value);
}

export function formatCurrency(value: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
  }).format(value);
}

export function formatCurrencyCompact(value: number, currency = 'USD'): string {
  if (Math.abs(value) < 10_000) return formatCurrency(value, currency);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatPercent(value: number, fractionDigits = 1): string {
  return `${(value * 100).toFixed(fractionDigits)}%`;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function formatSecondsShort(totalSeconds: number): string {
  if (totalSeconds <= 0) return 'Off';
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) return `${Math.round(totalSeconds / 60)} min`;
  if (totalSeconds < 86_400) return `${Math.round(totalSeconds / 3600)} h`;
  return `${Math.round(totalSeconds / 86_400)} d`;
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function formatRelative(iso: string, now = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return relative.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(diff / 3600), 'hour');
  if (abs < 7 * 86_400) return relative.format(Math.round(diff / 86_400), 'day');
  return formatDate(iso);
}

/** "6 min ago" style age, without "in"/"ago" ambiguity for future values. */
export function formatAge(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}
