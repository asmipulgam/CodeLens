import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { setCsrfToken } from '@/api/client';
import { fetchSession } from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import type { Permissions, Session } from '@/api/types';
import { PageLoader } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/misc';
import { ShieldAlert } from 'lucide-react';

const SessionContext = createContext<Session | null>(null);

export function useSessionQuery() {
  return useQuery({
    queryKey: qk.session,
    queryFn: fetchSession,
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: true,
  });
}

/** Renders children only for a signed-in user; otherwise sends them to /login. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { data: session, isPending, isError, refetch } = useSessionQuery();

  useEffect(() => {
    setCsrfToken(session?.csrfToken ?? null);
  }, [session?.csrfToken]);

  if (isPending) return <PageLoader label="Checking your sign-in" />;
  if (isError) {
    return (
      <EmptyState
        className="h-full"
        icon={<ShieldAlert />}
        title="Can't reach CodeLens"
        description="We couldn't confirm your sign-in. Check your connection or VPN and try again."
        action={<Button onClick={() => refetch()}>Try again</Button>}
      />
    );
  }
  if (!session) {
    const returnTo = location.pathname + location.search;
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }
  // Set synchronously too, so requests fired during this first render already carry the token.
  setCsrfToken(session.csrfToken);
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside RequireAuth');
  return session;
}

export function usePermissions(): Permissions {
  return useSession().user.permissions;
}

/** Hides a route from users without the permission. The backend still enforces it on every call. */
export function RequirePermission({ permission, children }: { permission: keyof Permissions; children: ReactNode }) {
  const permissions = usePermissions();
  if (!permissions[permission]) {
    return (
      <EmptyState
        className="h-full"
        icon={<ShieldAlert />}
        title="You don't have access to this page"
        description="Ask your CodeLens administrator if you think you should."
      />
    );
  }
  return <>{children}</>;
}
