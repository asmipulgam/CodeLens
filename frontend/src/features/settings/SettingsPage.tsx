import { LogOut, Monitor, Moon, ShieldCheck, Sun } from 'lucide-react';
import type { Preferences } from '@/api/types';
import { useTheme } from '@/app/theme';
import { useAuth } from '@/auth/AuthProvider';
import { useSession } from '@/auth/session';
import { SourceTypeIcon } from '@/components/SourceBits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { PageHeader, Segmented, Skeleton } from '@/components/ui/misc';
import { Switch } from '@/components/ui/switch';
import { usePreferences, useSources, useUpdatePreferences } from '@/features/shared/hooks';
import { formatDateTime } from '@/lib/format';

const ROLE_LABELS: Record<string, string> = {
  business: 'Business user',
  analyst: 'Analyst',
  admin: 'Admin',
  auditor: 'Auditor',
};

export function SettingsPage() {
  const session = useSession();
  const { user } = session;
  const { logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const preferences = usePreferences();
  const update = useUpdatePreferences();
  const sources = useSources();

  const prefs = preferences.data;
  const save = (patch: Partial<Preferences>) => prefs && update.mutate({ ...prefs, ...patch });
  const granted = (sources.data ?? []).filter((source) => source.access === 'granted');

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <PageHeader title="Settings" description="Personal preferences for how CodeLens looks and answers." />

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent>
          <Segmented
            label="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: 'Light', icon: <Sun /> },
              { value: 'dark', label: 'Dark', icon: <Moon /> },
              { value: 'system', label: 'System', icon: <Monitor /> },
            ]}
          />
        </CardContent>
      </Card>

      {(user.permissions.canViewQuery || user.permissions.canChooseSource) && (
        <Card>
          <CardHeader>
            <CardTitle>Answers</CardTitle>
            <CardDescription>Options available to your role.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {!prefs ? (
              <Skeleton className="h-16" />
            ) : (
              <>
                {user.permissions.canViewQuery && (
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <label htmlFor="show-query" className="text-sm font-medium">
                        Show generated queries
                      </label>
                      <p className="text-sm text-fg-secondary">
                        Show the SQL, MongoDB or Redis query under each answer. You can also switch this on any
                        answer.
                      </p>
                    </div>
                    <Switch
                      id="show-query"
                      checked={prefs.showGeneratedQuery}
                      onCheckedChange={(checked) => save({ showGeneratedQuery: checked })}
                    />
                  </div>
                )}
                {user.permissions.canChooseSource && (
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">Default data sources</legend>
                    <p className="text-sm text-fg-secondary">
                      Leave all unticked to let CodeLens choose automatically (recommended).
                    </p>
                    <div className="grid gap-2 pt-1 sm:grid-cols-2">
                      {granted.map((source) => {
                        const id = `default-${source.id}`;
                        const checked = prefs.defaultSourceIds.includes(source.id);
                        return (
                          <label
                            key={source.id}
                            htmlFor={id}
                            className="flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:bg-wash"
                          >
                            <Checkbox
                              id={id}
                              checked={checked}
                              onCheckedChange={() =>
                                save({
                                  defaultSourceIds: checked
                                    ? prefs.defaultSourceIds.filter((item) => item !== source.id)
                                    : [...prefs.defaultSourceIds, source.id],
                                })
                              }
                            />
                            <SourceTypeIcon type={source.type} />
                            {source.name}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Managed by your company sign-in. Contact IT to change these details.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-fg-secondary">Name</dt>
            <dd>{user.name}</dd>
            <dt className="text-fg-secondary">Email</dt>
            <dd>{user.email}</dd>
            <dt className="text-fg-secondary">Role</dt>
            <dd className="flex flex-wrap gap-1">
              {user.roles.map((role) => (
                <Badge key={role} tone="primary">
                  {ROLE_LABELS[role] ?? role}
                </Badge>
              ))}
            </dd>
            <dt className="text-fg-secondary">Session ends</dt>
            <dd>
              {formatDateTime(session.expiresAt)} (or after {Math.round(session.idleTimeoutSeconds / 60)} minutes of
              inactivity)
            </dd>
          </dl>
          <Button variant="outline" className="mt-5" onClick={() => void logout('signed_out')}>
            <LogOut aria-hidden="true" /> Sign out
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-success" aria-hidden="true" /> Privacy and security
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-fg-secondary">
            <li>CodeLens only reads data. It can never change or delete records.</li>
            <li>You only see data your role allows. Sensitive fields may be hidden.</li>
            <li>Your questions, the data sources used and any exports are recorded in the audit log.</li>
            <li>Nothing from the database is stored in your browser; signing out clears it from memory.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
