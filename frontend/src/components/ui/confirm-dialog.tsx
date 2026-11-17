import { useId, useState, type ReactNode } from 'react';
import { Button } from './button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { Input, Label } from './input';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  /** When set, the user must type this exact text to enable the confirm button. */
  requireText?: string;
  busy?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent size="sm">
        {/* Remount the body each time the dialog opens so typed text is reset. */}
        {props.open && <ConfirmBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function ConfirmBody({
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive,
  requireText,
  busy,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const blocked = requireText !== undefined && typed.trim() !== requireText;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      {(children || requireText) && (
        <DialogBody className="space-y-3">
          {children}
          {requireText && (
            <div className="space-y-1.5">
              <Label htmlFor={inputId}>
                Type <span className="font-mono font-semibold">{requireText}</span> to confirm
              </Label>
              <Input id={inputId} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            </div>
          )}
        </DialogBody>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant={destructive ? 'danger' : 'primary'} disabled={blocked || busy} onClick={onConfirm}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
