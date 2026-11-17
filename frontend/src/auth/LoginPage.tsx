import { Building2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Suspense, lazy } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { listAuthProviders, loginUrl } from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import { Logo } from '@/app/Logo';
import { Button } from '@/components/ui/button';
import { Callout, PageLoader } from '@/components/ui/misc';
import { safeReturnTo } from './returnTo';
import { useSessionQuery } from './session';

// Written inline so production builds (VITE_USE_MOCKS=false) drop the demo picker entirely.
const DemoRolePicker = import.meta.env.VITE_USE_MOCKS === 'true' ? lazy(() => import('./DemoRolePicker')) : null;

const REASON_MESSAGES: Record<string, { tone: 'info' | 'warning'; text: string }> = {
  signed_out: { tone: 'info', text: 'You have been signed out.' },
  idle: { tone: 'warning', text: 'You were signed out after a period of inactivity to protect company data.' },
  expired: { tone: 'warning', text: 'Your session has expired. Please sign in again.' },
  other_tab: { tone: 'info', text: 'You signed out in another tab.' },
  sign_in_failed: { tone: 'warning', text: "Sign-in didn't complete. Please try again." },
  no_access: {
    tone: 'warning',
    text: "This account doesn't have access to CodeLens yet. Ask your manager or IT to add you to a CodeLens group, or to add your Google address to the approved list.",
  },
};

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { data: session, isPending } = useSessionQuery();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const reason = REASON_MESSAGES[params.get('reason') ?? ''];
  // Which sign-in buttons to show. If this fails, the company sign-in still works.
  const providers = useQuery({ queryKey: qk.authProviders, queryFn: listAuthProviders, staleTime: Infinity, retry: 1 });
  const offersGoogle = providers.data?.some((provider) => provider.id === 'google') ?? false;

  if (isPending) return <PageLoader label="Checking your sign-in" />;
  if (session) return <Navigate to={returnTo} replace />;

  const signIn = (provider?: string) => {
    if (DemoRolePicker) {
      toast.info('Single sign-on is not connected in demo mode', { description: 'Pick a demo role below instead.' });
      return;
    }
    window.location.assign(loginUrl(returnTo, { provider }));
  };

  return (
    <main className="flex min-h-full items-center justify-center bg-page px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo size="lg" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Sign in to CodeLens</h1>
            <p className="mt-1 text-sm text-fg-secondary">Ask your company's data questions in plain English.</p>
          </div>
        </div>

        <div className="space-y-4 rounded-xl border border-line bg-surface p-6 shadow-sm">
          {reason && <Callout tone={reason.tone}>{reason.text}</Callout>}

          <Button size="lg" className="w-full" onClick={() => signIn()}>
            <Building2 aria-hidden="true" />
            Sign in with your company account
          </Button>

          {offersGoogle && (
            <>
              <div className="flex items-center gap-3 text-xs text-fg-muted" aria-hidden="true">
                <span className="h-px flex-1 bg-line" />
                or
                <span className="h-px flex-1 bg-line" />
              </div>
              <Button size="lg" variant="outline" className="w-full" onClick={() => signIn('google')}>
                <GoogleMark />
                Sign in with Google
              </Button>
              <p className="text-center text-xs text-fg-secondary">
                Google sign-in works only for addresses your company has approved.
              </p>
            </>
          )}

          <ul className="space-y-2 text-xs text-fg-secondary">
            <li className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />
              Single sign-on with multi-factor authentication. CodeLens never sees your password.
            </li>
            <li className="flex items-start gap-2">
              <LockKeyhole className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />
              Access is limited to the data your role allows, and activity is recorded for security.
            </li>
          </ul>
        </div>

        {DemoRolePicker && (
          <Suspense fallback={null}>
            <DemoRolePicker onSignedIn={() => navigate(returnTo, { replace: true })} />
          </Suspense>
        )}
      </div>
    </main>
  );
}

/** Google's standard "G" mark, as its sign-in branding guidelines ask for. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-4" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
