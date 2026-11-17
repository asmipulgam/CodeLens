import { useQuery } from '@tanstack/react-query';
import { adminListAccessRequests } from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RequestsTab } from './RequestsTab';
import { RolesTab } from './RolesTab';
import { UsersTab } from './UsersTab';

export function AccessPage() {
  const pending = useQuery({
    queryKey: qk.admin.requests('pending'),
    queryFn: () => adminListAccessRequests('pending'),
  });
  const pendingCount = pending.data?.length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users & access"
        description="People and groups come from your company sign-in. Roles decide what each person can do in CodeLens and which data sources they can ask about."
      />
      <Tabs defaultValue={pendingCount > 0 ? 'requests' : 'users'} key={pending.isPending ? 'loading' : 'ready'}>
        <TabsList>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="requests">
            Access requests
            {pendingCount > 0 && (
              <Badge tone="warning" className="ml-1">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="users">
          <UsersTab />
        </TabsContent>
        <TabsContent value="roles">
          <RolesTab />
        </TabsContent>
        <TabsContent value="requests">
          <RequestsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
