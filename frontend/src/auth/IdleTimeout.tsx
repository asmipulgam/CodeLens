import { useQueryClient } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { qk } from '@/api/queryKeys';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { createAuthChannel } from '@/lib/broadcast';
import { useAuth } from './AuthProvider';
import { useSession } from './session';

const WARNING_SECONDS = 120;
const KEEPALIVE_MS = 5 * 60_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove', 'scroll'] as const;

/**
 * Signs the user out after a period of inactivity (set by the backend), warning them first.
 * Activity in any open tab counts. While the user is active, the server session is kept alive.
 */
export function IdleTimeout() {
  const session = useSession();
  const { logout } = useAuth();
  const queryClient = useQueryClient();
  const timeoutMs = session.idleTimeoutSeconds * 1000;
  const lastActivity = useRef(Date.now());
  const lastBroadcast = useRef(0);
  const lastKeepAlive = useRef(Date.now());
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    const channel = createAuthChannel((signal) => {
      if (signal.type === 'activity') lastActivity.current = Math.max(lastActivity.current, signal.at);
    });

    const onActivity = () => {
      const now = Date.now();
      lastActivity.current = now;
      if (now - lastBroadcast.current > 15_000) {
        lastBroadcast.current = now;
        channel.post({ type: 'activity', at: now });
      }
    };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, { passive: true });

    const tick = () => {
      const now = Date.now();
      const remainingMs = timeoutMs - (now - lastActivity.current);
      if (remainingMs <= 0) {
        void logout('idle');
        return;
      }
      setSecondsLeft(remainingMs <= WARNING_SECONDS * 1000 ? Math.ceil(remainingMs / 1000) : null);
      if (now - lastKeepAlive.current > KEEPALIVE_MS && now - lastActivity.current < KEEPALIVE_MS) {
        lastKeepAlive.current = now;
        void queryClient.invalidateQueries({ queryKey: qk.session });
      }
    };
    const interval = window.setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);

    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
      channel.close();
    };
  }, [timeoutMs, logout, queryClient]);

  const stayActive = () => {
    lastActivity.current = Date.now();
    setSecondsLeft(null);
    void queryClient.invalidateQueries({ queryKey: qk.session });
  };

  const open = secondsLeft !== null;
  const minutes = Math.floor((secondsLeft ?? 0) / 60);
  const seconds = String((secondsLeft ?? 0) % 60).padStart(2, '0');

  return (
    <Dialog open={open} onOpenChange={(next) => !next && stayActive()}>
      <DialogContent size="sm" hideClose>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="size-5 text-warning" aria-hidden="true" /> Are you still there?
          </DialogTitle>
          <DialogDescription>
            To protect company data, you'll be signed out in{' '}
            <span className="font-semibold tabular text-fg" aria-live="polite">
              {minutes}:{seconds}
            </span>
            .
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => void logout('signed_out')}>
            Sign out now
          </Button>
          <Button onClick={stayActive}>Stay signed in</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
