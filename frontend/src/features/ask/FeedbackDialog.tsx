import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { sendFeedback } from '@/api/endpoints';
import type { FeedbackReason } from '@/api/types';
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
import { Label, Textarea } from '@/components/ui/input';
import { cn } from '@/lib/cn';

const REASONS: { value: FeedbackReason; label: string }[] = [
  { value: 'wrong_numbers', label: 'The numbers look wrong' },
  { value: 'wrong_source', label: 'It used the wrong data' },
  { value: 'did_not_answer', label: "It didn't answer my question" },
  { value: 'too_slow', label: 'It was too slow' },
  { value: 'other', label: 'Something else' },
];

export function FeedbackDialog({
  queryId,
  open,
  onOpenChange,
  onSent,
}: {
  queryId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open && <FeedbackForm queryId={queryId} onDone={() => onOpenChange(false)} onSent={onSent} />}
      </DialogContent>
    </Dialog>
  );
}

function FeedbackForm({ queryId, onDone, onSent }: { queryId: string; onDone: () => void; onSent: () => void }) {
  const [reason, setReason] = useState<FeedbackReason>('wrong_numbers');
  const [comment, setComment] = useState('');
  const commentId = useId();

  const mutation = useMutation({
    mutationFn: () => sendFeedback({ queryId, rating: 'down', reason, comment: comment.trim() || undefined }),
    onSuccess: () => {
      toast.success('Thanks — your feedback helps us improve answers.');
      onSent();
      onDone();
    },
    onError: (error) => toast.error("Couldn't send feedback", { description: errorMessage(error) }),
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Report a problem with this answer</DialogTitle>
        <DialogDescription>The data team reviews these reports to improve CodeLens.</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">What went wrong?</legend>
          {REASONS.map((item) => (
            <label
              key={item.value}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:bg-wash',
                reason === item.value && 'border-primary bg-primary-wash',
              )}
            >
              <input
                type="radio"
                name="reason"
                value={item.value}
                checked={reason === item.value}
                onChange={() => setReason(item.value)}
                className="accent-[rgb(var(--primary))]"
              />
              {item.label}
            </label>
          ))}
        </fieldset>
        <div className="space-y-1.5">
          <Label htmlFor={commentId}>Anything else? (optional)</Label>
          <Textarea
            id={commentId}
            value={comment}
            maxLength={1000}
            onChange={(event) => setComment(event.target.value)}
            placeholder="For example: the March total should be about $1.2M."
          />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Sending…' : 'Send report'}
        </Button>
      </DialogFooter>
    </form>
  );
}
