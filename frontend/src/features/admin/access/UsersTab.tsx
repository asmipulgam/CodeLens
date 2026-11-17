import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { adminListRoles, adminListUsers, adminSetUserRoles } from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import type { AdminUser, RoleDefinition } from '@/api/types';
import { RelativeTime } from '@/components/RelativeTime';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Input } from '@/components/ui/input';
import { Callout, Skeleton } from '@/components/ui/misc';

export function UsersTab() {
  const users = useQuery({ queryKey: qk.admin.users, queryFn: adminListUsers });
  const roles = useQuery({ queryKey: qk.admin.roles, queryFn: adminListRoles });
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<AdminUser | null>(null);

  const roleNames = useMemo(() => new Map((roles.data ?? []).map((role) => [role.id, role.name])), [roles.data]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const items = users.data ?? [];
    return term
      ? items.filter((user) => user.name.toLowerCase().includes(term) || user.email.toLowerCase().includes(term))
      : items;
  }, [users.data, search]);

  if (users.isPending) return <Skeleton className="h-64" />;
  if (users.isError) return <Callout tone="danger">{errorMessage(users.error)}</Callout>;

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-fg-muted" aria-hidden="true" />
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name or email"
          aria-label="Search users"
          className="pl-8"
        />
      </div>
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <caption className="sr-only">Users</caption>
          <thead className="bg-wash text-left text-xs text-fg-secondary">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Person
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Groups
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Roles
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Last active
              </th>
              <th scope="col" className="px-4 py-2.5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((user) => (
              <tr key={user.id} className="border-t border-line">
                <td className="px-4 py-3">
                  <p className="font-medium">{user.name}</p>
                  <p className="text-xs text-fg-secondary">{user.email}</p>
                  {user.status === 'disabled' && (
                    <Badge tone="neutral" className="mt-1">
                      Disabled in company directory
                    </Badge>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-fg-secondary">{user.groups.join(', ') || '—'}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {user.roleIds.length === 0 ? (
                      <span className="text-xs text-fg-secondary">No roles</span>
                    ) : (
                      user.roleIds.map((id) => (
                        <Badge key={id} tone="primary">
                          {roleNames.get(id) ?? id}
                        </Badge>
                      ))
                    )}
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-fg-secondary">
                  {user.lastActiveAt ? <RelativeTime iso={user.lastActiveAt} /> : 'Never'}
                </td>
                <td className="px-4 py-3 text-right">
                  <Button variant="outline" size="sm" onClick={() => setEditing(user)}>
                    Edit roles
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          {editing && roles.data && <RoleEditor user={editing} roles={roles.data} onDone={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RoleEditor({ user, roles, onDone }: { user: AdminUser; roles: RoleDefinition[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>(user.roleIds);
  const save = useMutation({
    mutationFn: () => adminSetUserRoles(user.id, selected),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.admin.users });
      void qc.invalidateQueries({ queryKey: qk.admin.roles });
      toast.success(`Roles updated for ${user.name}`);
      onDone();
    },
    onError: (error) => toast.error("Couldn't update roles", { description: errorMessage(error) }),
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>Roles for {user.name}</DialogTitle>
        <DialogDescription>Changes apply the next time they ask a question. The change is recorded in the audit log.</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-2">
        {roles.map((role) => {
          const id = `user-role-${role.id}`;
          const checked = selected.includes(role.id);
          return (
            <label key={role.id} htmlFor={id} className="flex cursor-pointer items-start gap-2 rounded-lg border border-line p-3 hover:bg-wash">
              <Checkbox
                id={id}
                className="mt-0.5"
                checked={checked}
                onCheckedChange={() => setSelected(checked ? selected.filter((item) => item !== role.id) : [...selected, role.id])}
              />
              <span>
                <span className="block text-sm font-medium">{role.name}</span>
                <span className="block text-xs text-fg-secondary">{role.description}</span>
              </span>
            </label>
          );
        })}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save roles'}
        </Button>
      </DialogFooter>
    </>
  );
}
