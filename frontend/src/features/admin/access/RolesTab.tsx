import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Minus, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { adminCreateRole, adminListRoles, adminListSources, adminUpdateRole } from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import type { AdminSource, Permissions, RoleDefinition, RoleInput } from '@/api/types';
import { SourceTypeIcon } from '@/components/SourceBits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldError, Input } from '@/components/ui/input';
import { Callout, Skeleton } from '@/components/ui/misc';
import { Switch } from '@/components/ui/switch';
import { formatNumber } from '@/lib/format';

const PERMISSION_LABELS: { key: Exclude<keyof Permissions, 'exportRowLimit'>; label: string; description: string }[] = [
  { key: 'canExport', label: 'Export and copy results', description: 'Download CSV files and copy tables.' },
  { key: 'canViewQuery', label: 'See generated queries', description: 'View the SQL / MongoDB / Redis query behind answers.' },
  { key: 'canChooseSource', label: 'Choose data sources', description: 'Pin questions to specific databases.' },
  { key: 'canAudit', label: 'View the audit log', description: 'Read-only access to every recorded action.' },
  { key: 'canAdmin', label: 'Administer CodeLens', description: 'Connect databases, manage roles, cache and users.' },
];

const DEFAULT_PERMISSIONS: Permissions = {
  canExport: false,
  canViewQuery: false,
  canChooseSource: false,
  canAudit: false,
  canAdmin: false,
  exportRowLimit: 1000,
};

export function RolesTab() {
  const roles = useQuery({ queryKey: qk.admin.roles, queryFn: adminListRoles });
  const sources = useQuery({ queryKey: qk.admin.sources, queryFn: adminListSources });
  const [editing, setEditing] = useState<RoleDefinition | 'new' | null>(null);

  if (roles.isPending) return <Skeleton className="h-64" />;
  if (roles.isError) return <Callout tone="danger">{errorMessage(roles.error)}</Callout>;

  const sourceNames = new Map((sources.data ?? []).map((source) => [source.id, source]));

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setEditing('new')}>
          <Plus aria-hidden="true" /> New role
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {roles.data.map((role) => (
          <Card key={role.id}>
            <CardHeader>
              <div className="flex items-center gap-2">
                <CardTitle>{role.name}</CardTitle>
                {role.builtIn && <Badge tone="outline">Built-in</Badge>}
                <span className="ml-auto text-xs text-fg-secondary">{role.memberCount} people</span>
              </div>
              <CardDescription>{role.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-1 text-sm">
                {PERMISSION_LABELS.map((permission) => {
                  const allowed = role.permissions[permission.key];
                  return (
                    <li key={permission.key} className={allowed ? 'text-fg' : 'text-fg-muted'}>
                      {allowed ? (
                        <Check className="mr-1.5 inline size-4" style={{ color: 'var(--status-good)' }} aria-label="Allowed" />
                      ) : (
                        <Minus className="mr-1.5 inline size-4" aria-label="Not allowed" />
                      )}
                      {permission.label}
                      {permission.key === 'canExport' && allowed && (
                        <span className="text-fg-secondary"> (up to {formatNumber(role.permissions.exportRowLimit)} rows)</span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div>
                <p className="mb-1.5 text-xs font-medium text-fg-secondary">Data sources</p>
                <div className="flex flex-wrap gap-1.5">
                  {role.sourceIds.length === 0 ? (
                    <span className="text-xs text-fg-secondary">None</span>
                  ) : (
                    role.sourceIds.map((id) => {
                      const source = sourceNames.get(id);
                      return (
                        <Badge key={id} tone="neutral">
                          {source && <SourceTypeIcon type={source.type} className="size-3" />}
                          {source?.name ?? id}
                        </Badge>
                      );
                    })
                  )}
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <Button variant="outline" size="sm" onClick={() => setEditing(role)}>
                Edit role
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent size="lg">
          {editing !== null && (
            <RoleForm
              role={editing === 'new' ? undefined : editing}
              sources={sources.data ?? []}
              onDone={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RoleForm({ role, sources, onDone }: { role?: RoleDefinition; sources: AdminSource[]; onDone: () => void }) {
  const qc = useQueryClient();
  const nameId = useId();
  const descId = useId();
  const limitId = useId();
  const [input, setInput] = useState<RoleInput>({
    name: role?.name ?? '',
    description: role?.description ?? '',
    permissions: role?.permissions ?? DEFAULT_PERMISSIONS,
    sourceIds: role?.sourceIds ?? [],
  });
  const [touched, setTouched] = useState(false);
  const nameError = input.name.trim().length < 2 ? 'Give the role a name.' : undefined;
  const limitError =
    input.permissions.canExport && (input.permissions.exportRowLimit < 1 || input.permissions.exportRowLimit > 1_000_000)
      ? 'Choose a limit between 1 and 1,000,000 rows.'
      : undefined;

  const save = useMutation({
    mutationFn: () => (role ? adminUpdateRole(role.id, input) : adminCreateRole(input)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.admin.roles });
      toast.success(role ? 'Role updated' : 'Role created');
      onDone();
    },
    onError: (error) => toast.error("Couldn't save the role", { description: errorMessage(error) }),
  });

  const setPermission = (key: keyof Permissions, value: boolean | number) =>
    setInput({ ...input, permissions: { ...input.permissions, [key]: value } });

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (!nameError && !limitError) save.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>{role ? `Edit ${role.name}` : 'New role'}</DialogTitle>
        <DialogDescription>Changing permissions affects everyone with this role and is recorded in the audit log.</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={nameId} label="Name" required error={touched ? nameError : undefined}>
            <Input id={nameId} value={input.name} maxLength={60} onChange={(event) => setInput({ ...input, name: event.target.value })} />
          </Field>
          <Field id={descId} label="Description">
            <Input
              id={descId}
              value={input.description}
              maxLength={200}
              onChange={(event) => setInput({ ...input, description: event.target.value })}
            />
          </Field>
        </div>

        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-semibold">Permissions</legend>
          {PERMISSION_LABELS.map((permission) => {
            const id = `perm-${permission.key}`;
            return (
              <div key={permission.key} className="flex items-start justify-between gap-4">
                <div>
                  <label htmlFor={id} className="text-sm font-medium">
                    {permission.label}
                  </label>
                  <p className="text-xs text-fg-secondary">{permission.description}</p>
                </div>
                <Switch
                  id={id}
                  checked={input.permissions[permission.key]}
                  onCheckedChange={(checked) => setPermission(permission.key, checked)}
                />
              </div>
            );
          })}
          {input.permissions.canExport && (
            <Field id={limitId} label="Export row limit" className="max-w-48">
              <Input
                id={limitId}
                inputMode="numeric"
                value={String(input.permissions.exportRowLimit)}
                onChange={(event) => setPermission('exportRowLimit', Number(event.target.value.replace(/\D/g, '')) || 0)}
              />
              <FieldError>{touched ? limitError : undefined}</FieldError>
            </Field>
          )}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-semibold">Data sources this role can ask about</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {sources.map((source) => {
              const id = `role-source-${source.id}`;
              const checked = input.sourceIds.includes(source.id);
              return (
                <label key={source.id} htmlFor={id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:bg-wash">
                  <Checkbox
                    id={id}
                    checked={checked}
                    onCheckedChange={() =>
                      setInput({
                        ...input,
                        sourceIds: checked ? input.sourceIds.filter((item) => item !== source.id) : [...input.sourceIds, source.id],
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
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : role ? 'Save role' : 'Create role'}
        </Button>
      </DialogFooter>
    </form>
  );
}
