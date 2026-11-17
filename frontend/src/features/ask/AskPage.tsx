import { useQueryClient } from '@tanstack/react-query';
import { MessageSquareText, PanelLeft } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { NEW_CONVERSATION, qk } from '@/api/queryKeys';
import type { AssistantMessage, Conversation, SavedQuestion } from '@/api/types';
import { useSession } from '@/auth/session';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, PageLoader } from '@/components/ui/misc';
import { usePreferences, useSources } from '@/features/shared/hooks';
import { isApiError } from '@/api/client';
import { Composer } from './Composer';
import { HistorySidebar } from './HistorySidebar';
import { MessageList } from './MessageList';
import { emptyConversation, isConversationBusy, useConversation, useQueryRunner } from './runner';
import { WelcomeScreen } from './WelcomeScreen';

/** Navigation state other pages can pass to prefill the question box. */
export interface AskNavigationState {
  prefill?: string;
  sourceIds?: string[];
}

export function AskPage() {
  const { conversationId } = useParams();
  const key = conversationId ?? NEW_CONVERSATION;
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useSession();
  const runner = useQueryRunner();
  const conversation = useConversation(key);
  const sources = useSources();
  const preferences = usePreferences();
  const navState = (location.state ?? {}) as AskNavigationState;

  const [historyOpen, setHistoryOpen] = useState(false);
  const [sourceIds, setSourceIds] = useState<string[]>(navState.sourceIds ?? []);
  const [sourcesTouched, setSourcesTouched] = useState(Boolean(navState.sourceIds));
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);

  const canChooseSource = user.permissions.canChooseSource;
  const defaultSourceIds = preferences.data?.defaultSourceIds;
  const effectiveSourceIds = useMemo(
    () => (canChooseSource ? (sourcesTouched ? sourceIds : (defaultSourceIds ?? [])) : []),
    [canChooseSource, sourcesTouched, sourceIds, defaultSourceIds],
  );

  const messages = useMemo(() => conversation.data?.messages ?? [], [conversation.data]);
  const busy = isConversationBusy(conversation.data);

  const ask = useCallback(
    (question: string, ids: string[] = effectiveSourceIds) => {
      nearBottomRef.current = true;
      runner.ask({ conversationId, question, sourceIds: ids });
    },
    [runner, conversationId, effectiveSourceIds],
  );

  const startNewConversation = useCallback(() => {
    const draft = qc.getQueryData<Conversation>(qk.conversation(NEW_CONVERSATION));
    if (!isConversationBusy(draft)) qc.setQueryData(qk.conversation(NEW_CONVERSATION), emptyConversation());
    setHistoryOpen(false);
    navigate('/ask');
  }, [qc, navigate]);

  const askSaved = useCallback(
    (saved: SavedQuestion) => {
      qc.setQueryData(qk.conversation(NEW_CONVERSATION), emptyConversation());
      setHistoryOpen(false);
      navigate('/ask');
      runner.ask({ question: saved.question, sourceIds: canChooseSource ? saved.sourceIds : [] });
    },
    [qc, navigate, runner, canChooseSource],
  );

  const stop = () => {
    const running = [...messages]
      .reverse()
      .find((m): m is AssistantMessage => m.role === 'assistant' && (m.status === 'running' || Boolean(m.refreshing)));
    if (running) runner.cancel(key, running);
  };

  // Jump to the bottom when switching conversations; follow new content if already near the bottom.
  useLayoutEffect(() => {
    nearBottomRef.current = true;
  }, [key]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && nearBottomRef.current) element.scrollTo({ top: element.scrollHeight });
  }, [messages, key]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
  };

  const sidebarProps = {
    activeId: conversationId,
    onNewQuestion: startNewConversation,
    onAskSaved: askSaved,
  };

  let body: ReactNode;
  if (conversation.isPending) {
    body = <PageLoader label="Loading conversation" />;
  } else if (conversation.isError) {
    body = (
      <EmptyState
        icon={<MessageSquareText />}
        title={isApiError(conversation.error, 'not_found') ? 'Conversation not found' : "Couldn't load this conversation"}
        description="It may have been deleted, or you may not have access to it."
        action={<Button onClick={startNewConversation}>Ask a new question</Button>}
      />
    );
  } else if (messages.length === 0) {
    body = <WelcomeScreen name={user.name} sources={sources.data ?? []} onAsk={(question) => ask(question)} />;
  } else {
    body = <MessageList conversationKey={key} messages={messages} runner={runner} onAsk={(question) => ask(question)} />;
  }

  return (
    <div className="flex h-full">
      <HistorySidebar {...sidebarProps} className="hidden lg:flex" />

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent
          size="sm"
          hideClose
          className="left-0 top-0 h-full max-h-full w-72 translate-x-0 translate-y-0 animate-fade-in rounded-none"
        >
          <DialogTitle className="sr-only">Conversations</DialogTitle>
          <HistorySidebar {...sidebarProps} onNavigate={() => setHistoryOpen(false)} className="h-full w-full border-0" />
        </DialogContent>
      </Dialog>

      <section className="flex min-w-0 flex-1 flex-col" aria-label="Ask">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 lg:hidden">
          <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
            <PanelLeft aria-hidden="true" /> History
          </Button>
          <span className="truncate text-sm text-fg-secondary">{conversation.data?.title}</span>
        </div>
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-4xl px-3 py-6 sm:px-4">{body}</div>
        </div>
        <Composer
          key={`${key}:${navState.prefill ?? ''}`}
          initialText={navState.prefill}
          sources={sources.data ?? []}
          sourceIds={effectiveSourceIds}
          onSourceIdsChange={(ids) => {
            setSourcesTouched(true);
            setSourceIds(ids);
          }}
          canChooseSource={canChooseSource}
          busy={busy}
          onSubmit={(question) => ask(question)}
          onStop={stop}
        />
      </section>
    </div>
  );
}
