import { ArrowUp, ShieldCheck, Square } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { SourceSummary } from '@/api/types';
import { Button } from '@/components/ui/button';
import { SourcePicker } from './SourcePicker';

const MAX_LENGTH = 2000;

interface ComposerProps {
  initialText?: string;
  sources: SourceSummary[];
  sourceIds: string[];
  onSourceIdsChange: (ids: string[]) => void;
  canChooseSource: boolean;
  busy: boolean;
  onSubmit: (question: string) => void;
  onStop: () => void;
}

export function Composer({
  initialText = '',
  sources,
  sourceIds,
  onSourceIdsChange,
  canChooseSource,
  busy,
  onSubmit,
  onStop,
}: ComposerProps) {
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

  useEffect(() => {
    if (initialText) textareaRef.current?.focus();
  }, [initialText]);

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !busy;

  const submit = () => {
    if (!canSend) return;
    onSubmit(trimmed);
    setText('');
  };

  return (
    <div className="border-t border-line bg-page/95 px-3 pb-3 pt-3 sm:px-4">
      <form
        className="mx-auto max-w-4xl"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="rounded-2xl border border-line bg-raised shadow-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
          <label htmlFor="ask-input" className="sr-only">
            Ask a question about your data
          </label>
          <textarea
            id="ask-input"
            ref={textareaRef}
            value={text}
            rows={1}
            maxLength={MAX_LENGTH}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Ask a question, e.g. “What were total sales by region last month?”"
            aria-describedby={hintId}
            className="block w-full resize-none bg-transparent px-4 pb-2 pt-3 text-[15px] leading-relaxed text-fg placeholder:text-fg-muted focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <div className="flex items-center gap-2 px-3 pb-2.5">
            {canChooseSource && <SourcePicker sources={sources} value={sourceIds} onChange={onSourceIdsChange} />}
            {text.length > MAX_LENGTH * 0.8 && (
              <span className="text-xs text-fg-secondary tabular">
                {text.length}/{MAX_LENGTH}
              </span>
            )}
            <span className="ml-auto" />
            {busy ? (
              <Button type="button" size="icon-sm" variant="secondary" onClick={onStop} aria-label="Stop answering">
                <Square className="fill-current" />
              </Button>
            ) : (
              <Button type="submit" size="icon-sm" disabled={!canSend} aria-label="Send question">
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
        <p id={hintId} className="mt-2 flex items-center justify-center gap-1.5 text-center text-xs text-fg-secondary">
          <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
          Read-only access. Don't paste passwords or customers' personal details into questions.
        </p>
      </form>
    </div>
  );
}
