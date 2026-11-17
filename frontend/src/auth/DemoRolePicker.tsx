import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { api, errorMessage } from '@/api/client';
import { qk } from '@/api/queryKeys';
import type { Role, Session } from '@/api/types';
import { Callout } from '@/components/ui/misc';

/**
 * DEMO BUILDS ONLY. Lets you sign in as a demo role against the mock backend.
 * LoginPage imports this lazily behind VITE_USE_MOCKS, so production bundles never contain it.
 */
const DEMO_ROLES: { role: Role; title: string; description: string }[] = [
  { role: 'business', title: 'Business user', description: 'Asks questions and reads answers' },
  { role: 'analyst', title: 'Analyst', description: 'Also sees generated queries and picks databases' },
  { role: 'admin', title: 'Admin', description: 'Connects databases and manages access' },
  { role: 'auditor', title: 'Auditor', description: 'Reviews the audit log (read-only)' },
];

export default function DemoRolePicker({ onSignedIn }: { onSignedIn: () => void }) {
  const queryClient = useQueryClient();
  const demo = useMutation({
    mutationFn: (role: Role) => api.post<Session>('/auth/demo-login', { role }),
    onSuccess: (session) => {
      queryClient.setQueryData(qk.session, session);
      onSignedIn();
    },
  });

  return (
    <div className="space-y-3 rounded-xl border border-dashed border-line-strong bg-surface/60 p-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Info className="size-4 text-primary" aria-hidden="true" />
        Demo mode: pick a role to explore
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {DEMO_ROLES.map((item) => (
          <button
            key={item.role}
            type="button"
            disabled={demo.isPending}
            onClick={() => demo.mutate(item.role)}
            className="rounded-lg border border-line bg-raised p-3 text-left transition-colors hover:border-primary hover:bg-primary-wash disabled:opacity-60"
          >
            <span className="block text-sm font-medium">{item.title}</span>
            <span className="block text-xs text-fg-secondary">{item.description}</span>
          </button>
        ))}
      </div>
      {demo.isError && <Callout tone="danger">{errorMessage(demo.error)}</Callout>}
    </div>
  );
}
