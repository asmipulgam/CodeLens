import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { adminDecideAccessRequest, adminListAccessRequests } from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import type { AccessRequest, AccessRequestStatus } from '@/api/types';
import { RelativeTime } from '@/components/RelativeTime';
import { SourceChip } from '@/components/SourceBits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/input';
import { Callout, EmptyState, Segmented, Skeleton } from '@/components/ui/misc';

const STATUS_TONE = { pending: 'warning', approved: 'success', rejected: 'danger' } as const;

export function RequestsTab() {
  const [filter, setFilter] = useState<AccessRequestStatus | 'all'>('pending');
  const requests = useQuery({
    queryKey: qk.admin.requests(filter === 'all' ? undefined : filter),
    queryFn: () => adminListAccessRequests(filter === 'all' ? undefined : filter),
  });
  const [deciding, setDeciding] = useState<{ request: AccessRequest; decision: 'approve' | 'reject' } | null>(null);

  return (
    <div className="space-y-4">
      <Segmented
        label="Filter requests"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'pending', label: 'Pending' },
          { value: 'approved', label: 'Approved' },
          { value: 'rejected', label: 'Rejected' },
          { value: 'all', label: 'All' },
        ]}
      />
      {requests.isPending ? (
        <Skeleton className="h-48" />
      ) : requests.isError ? (
        <Callout tone="danger">{errorMessage(requests.error)}</Callout>
      ) : requests.data.length === 0 ? (
        <EmptyState icon={<Inbox />} title={filter === 'pending' ? 'No pending requests' : 'No requests'} />
      ) : (
        <ul className="space-y-3">
          {requests.data.map((request) => (
            <li key={request.id} className="space-y-3 rounded-xl border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{request.user.name}</span>
                <span className="text-sm text-fg-secondary">{request.user.email}</span>
                <span className="text-sm text-fg-secondary">requested</span>
                <SourceChip source={request.source} />
                <span className="ml-auto text-xs text-fg-secondary">
                  <RelativeTime iso={request.createdAt} />
                </span>
              </div>
              <blockquote className="border-l-2 border-line pl-3 text-sm text-fg-secondary">{request.reason}</blockquote>
              {request.status === 'pending' ? (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setDeciding({ request, decision: 'approve' })}>
                    Approve
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setDeciding({ request, decision: 'reject' })}>
                    Reject
                  </Button>
                </div>
              ) : (
                <p className="flex flex-wrap items-center gap-2 text-sm text-fg-secondary">
                  <Badge tone={STATUS_TONE[request.status]} className="capitalize">
                    {request.status}
                  </Badge>
                  {request.decidedBy && <>by {request.decidedBy}</>}
                  {request.note && <span>— “{request.note}”</span>}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={deciding !== null} onOpenChange={(open) => !open && setDeciding(null)}>
        <DialogContent>
          {deciding && <DecisionForm {...deciding} onDone={() => setDeciding(null)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DecisionForm({
  request,
  decision,
  onDone,
}: {
  request: AccessRequest;
  decision: 'approve' | 'reject';
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const noteId = useId();
  const [note, setNote] = useState('');
  const mutation = useMutation({
    mutationFn: () => adminDecideAccessRequest(request.id, decision, note.trim()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'access-requests'] });
      void qc.invalidateQueries({ queryKey: qk.admin.users });
      toast.success(decision === 'approve' ? 'Access granted' : 'Request rejected');
      onDone();
    },
    onError: (error) => toast.error("Couldn't record the decision", { description: errorMessage(error) }),
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>{decision === 'approve' ? 'Approve access?' : 'Reject request?'}</DialogTitle>
        <DialogDescription>
          {decision === 'approve'
            ? `${request.user.name} will be able to ask questions about ${request.source.name}.`
            : `${request.user.name} will be told their request was not approved.`}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <Field id={noteId} label="Note to the requester (optional)">
          <Textarea id={noteId} value={note} maxLength={300} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant={decision === 'approve' ? 'primary' : 'danger'} disabled={mutation.isPending}>
          {decision === 'approve' ? 'Approve' : 'Reject'}
        </Button>
      </DialogFooter>
    </form>
  );
}
