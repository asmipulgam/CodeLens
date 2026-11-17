import { useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { setCsrfToken, setUnauthorizedHandler } from '@/api/client';
import { loginUrl, logoutRequest } from '@/api/endpoints';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { abortAllStreams } from '@/features/ask/runner';
import { broadcastLogout, createAuthChannel } from '@/lib/broadcast';

export type LogoutReason = 'signed_out' | 'idle' | 'expired' | 'other_tab';

interface AuthContextValue {
  logout: (reason?: LogoutReason) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function isSafeExternalUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && parsed.hostname === 'localhost');
  } catch {
    return false;
  }
}

/**
 * Owns sign-out and session-expiry handling:
 *  - wipes every cached response from memory on sign-out or expiry,
 *  - signs out all open tabs together,
 *  - asks the user to re-authenticate when the backend requires a fresh sign-in (step-up).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const endingRef = useRef(false);
  const locationRef = useRef(location);
  locationRef.current = location;

  const clearClientState = useCallback(() => {
    abortAllStreams();
    setCsrfToken(null);
    queryClient.cancelQueries();
    queryClient.clear();
  }, [queryClient]);

  const goToLogin = useCallback(
    (reason: LogoutReason, keepReturnTo: boolean) => {
      const params = new URLSearchParams({ reason });
      if (keepReturnTo) {
        const { pathname, search } = locationRef.current;
        params.set('returnTo', pathname + search);
      }
      navigate(`/login?${params.toString()}`, { replace: true });
    },
    [navigate],
  );

  const logout = useCallback(
    async (reason: LogoutReason = 'signed_out') => {
      if (endingRef.current) return;
      endingRef.current = true;
      let redirectUrl: string | undefined;
      try {
        redirectUrl = (await logoutRequest()).redirectUrl;
      } catch {
        // Even if the server call fails, the local session state is still wiped.
      }
      clearClientState();
      broadcastLogout(reason);
      if (redirectUrl && isSafeExternalUrl(redirectUrl)) {
        window.location.assign(redirectUrl);
        return;
      }
      goToLogin(reason, reason === 'idle');
      endingRef.current = false;
    },
    [clearClientState, goToLogin],
  );

  // Any API call that comes back 401 means the session ended (or a fresh sign-in is required).
  useEffect(() => {
    setUnauthorizedHandler((error) => {
      if (error.code === 'step_up_required') {
        setStepUpOpen(true);
        return;
      }
      if (endingRef.current) return;
      endingRef.current = true;
      clearClientState();
      goToLogin('expired', true);
      endingRef.current = false;
    });
    return () => setUnauthorizedHandler(null);
  }, [clearClientState, goToLogin]);

  // Sign-out in another tab signs this tab out too.
  useEffect(() => {
    const channel = createAuthChannel((signal) => {
      if (signal.type !== 'logout') return;
      clearClientState();
      if (locationRef.current.pathname !== '/login') goToLogin('other_tab', false);
    });
    return channel.close;
  }, [clearClientState, goToLogin]);

  const value = useMemo(() => ({ logout }), [logout]);

  const reauthenticate = () => {
    const { pathname, search } = locationRef.current;
    window.location.assign(loginUrl(pathname + search, { reauthenticate: true }));
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
      <Dialog open={stepUpOpen} onOpenChange={setStepUpOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-primary" aria-hidden="true" /> Confirm it's you
            </DialogTitle>
            <DialogDescription>
              This action changes security settings. Please sign in again to continue.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStepUpOpen(false)}>
              Cancel
            </Button>
            <Button onClick={reauthenticate}>Sign in again</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
