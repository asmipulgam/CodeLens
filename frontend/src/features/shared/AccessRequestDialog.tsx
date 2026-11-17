import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { requestAccess } from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import type { SourceRef } from '@/api/types';
import { SourceChip } from '@/components/SourceBits';
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

interface Props {
  source: SourceRef | null;
  onOpenChange: (open: boolean) => void;
}

export function AccessRequestDialog({ source, onOpenChange }: Props) {
  return (
    <Dialog open={source !== null} onOpenChange={onOpenChange}>
      <DialogContent>{source && <RequestForm source={source} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function RequestForm({ source, onDone }: { source: SourceRef; onDone: () => void }) {
  const qc = useQueryClient();
  const id = useId();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const tooShort = reason.trim().length < 10;

  const mutation = useMutation({
    mutationFn: () => requestAccess(source.id, reason.trim()),
    onSuccess: () => {
      toast.success('Access requested', { description: 'An administrator will review your request.' });
      void qc.invalidateQueries({ queryKey: qk.sources });
      onDone();
    },
    onError: (error) => toast.error("Couldn't send your request", { description: errorMessage(error) }),
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (!tooShort) mutation.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Request access</DialogTitle>
        <DialogDescription>Administrators review every request. You'll be able to ask about this data once approved.</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <SourceChip source={source} />
        <Field
          id={id}
          label="Why do you need access?"
          hint="For example: “I answer client questions about their order history.”"
          error={touched && tooShort ? 'Please add a short reason (at least 10 characters).' : undefined}
          required
        >
          <Textarea
            id={id}
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            aria-invalid={touched && tooShort}
          />
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Sending…' : 'Send request'}
        </Button>
      </DialogFooter>
    </form>
  );
}
