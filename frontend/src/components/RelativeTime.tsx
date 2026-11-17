import { useEffect, useState } from 'react';
import { formatAge, formatDateTime, formatRelative } from '@/lib/format';

/** Re-renders every 30s so "5 min ago" stays accurate. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function RelativeTime({ iso, mode = 'relative' }: { iso: string; mode?: 'relative' | 'age' }) {
  const now = useNow();
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {mode === 'age' ? formatAge(iso, now) : formatRelative(iso, now)}
    </time>
  );
}
