import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { cancelQuery, getConversation, queryPaths } from '@/api/endpoints';
import { NEW_CONVERSATION, qk } from '@/api/queryKeys';
import { streamQueryEvents } from '@/api/stream';
import type { AssistantMessage, Conversation, QueryError, UserMessage } from '@/api/types';

/**
 * Runs questions as streams and writes progress into the React Query cache, which is the single
 * source of truth for a conversation's messages. Streams are tracked at module level so they
 * survive page remounts (e.g. /ask → /ask/:id) and can all be aborted on sign-out.
 */

interface ActiveStream {
  controller: AbortController;
  conversationKey: string;
  queryId?: string;
}

const activeStreams = new Map<string, ActiveStream>();

/** Called on sign-out so no in-flight answer can write data back into a wiped cache. */
export function abortAllStreams() {
  for (const stream of activeStreams.values()) stream.controller.abort();
  activeStreams.clear();
}

export function emptyConversation(id: string = NEW_CONVERSATION): Conversation {
  return { id, title: 'New question', pinned: false, updatedAt: new Date().toISOString(), messages: [] };
}

export function useConversation(key: string) {
  return useQuery({
    queryKey: qk.conversation(key),
    queryFn: () => (key === NEW_CONVERSATION ? Promise.resolve(emptyConversation()) : getConversation(key)),
    // The cache is authoritative while the user is working; streams write straight into it.
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  });
}

export function isConversationBusy(conversation: Conversation | undefined) {
  return Boolean(
    conversation?.messages.some((m) => m.role === 'assistant' && (m.status === 'running' || m.refreshing)),
  );
}

function updateConversation(qc: QueryClient, key: string, fn: (conversation: Conversation) => Conversation) {
  qc.setQueryData<Conversation>(qk.conversation(key), (old) => fn(old ?? emptyConversation(key)));
}

function patchMessage(qc: QueryClient, key: string, messageId: string, patch: Partial<AssistantMessage>) {
  updateConversation(qc, key, (conversation) => ({
    ...conversation,
    messages: conversation.messages.map((message) =>
      message.id === messageId && message.role === 'assistant' ? { ...message, ...patch } : message,
    ),
  }));
}

function errorFromException(error: unknown): QueryError {
  if (error instanceof ApiError) {
    if (error.status === 403) return { code: 'forbidden', message: error.message };
    if (error.status === 429) {
      return { code: 'rate_limited', message: error.message, hint: 'Wait a moment, then try again.' };
    }
    return { code: 'internal', message: error.message, hint: 'Try asking again.' };
  }
  return {
    code: 'internal',
    message: 'The connection was interrupted before the answer arrived.',
    hint: 'Try asking again.',
  };
}

interface StreamOptions {
  qc: QueryClient;
  path: string;
  body: unknown;
  conversationKey: string;
  messageId: string;
  refresh?: boolean;
  onConversationCreated?: (id: string) => void;
}

async function runStream({ qc, path, body, conversationKey, messageId, refresh, onConversationCreated }: StreamOptions) {
  const controller = new AbortController();
  const stream: ActiveStream = { controller, conversationKey };
  activeStreams.set(messageId, stream);
  let settled = false;

  const patch = (update: Partial<AssistantMessage>) => patchMessage(qc, stream.conversationKey, messageId, update);
  const fail = (error: QueryError) => {
    if (refresh) {
      patch({ refreshing: false, stage: undefined });
      toast.error("Couldn't refresh this answer", { description: error.message });
    } else {
      patch({ status: 'error', error, stage: undefined });
    }
  };

  try {
    for await (const event of streamQueryEvents(path, body, controller.signal)) {
      if (controller.signal.aborted) break;
      switch (event.type) {
        case 'started': {
          stream.queryId = event.queryId;
          if (!refresh) patch({ queryId: event.queryId });
          if (stream.conversationKey === NEW_CONVERSATION && event.conversationId) {
            const draft = qc.getQueryData<Conversation>(qk.conversation(NEW_CONVERSATION)) ?? emptyConversation();
            qc.setQueryData<Conversation>(qk.conversation(event.conversationId), { ...draft, id: event.conversationId });
            qc.setQueryData<Conversation>(qk.conversation(NEW_CONVERSATION), emptyConversation());
            stream.conversationKey = event.conversationId;
            onConversationCreated?.(event.conversationId);
          }
          void qc.invalidateQueries({ queryKey: qk.conversations });
          break;
        }
        case 'progress':
          patch({ stage: event.stage });
          break;
        case 'clarification':
          settled = true;
          patch({ status: 'needs_clarification', clarification: event.clarification, stage: undefined });
          break;
        case 'confirmation':
          settled = true;
          patch({ status: 'needs_confirmation', confirmation: event.confirmation, stage: undefined });
          break;
        case 'result':
          settled = true;
          patch({
            status: 'done',
            answer: event.answer,
            queryId: event.answer.queryId,
            refreshing: false,
            stage: undefined,
            error: undefined,
          });
          break;
        case 'error':
          settled = true;
          fail(event.error);
          break;
      }
    }
    if (!settled && !controller.signal.aborted) {
      fail({ code: 'internal', message: 'The connection closed before the answer arrived.', hint: 'Try asking again.' });
    }
  } catch (error) {
    if (!controller.signal.aborted) fail(errorFromException(error));
  } finally {
    activeStreams.delete(messageId);
    void qc.invalidateQueries({ queryKey: qk.conversations });
  }
}

export interface AskInput {
  /** Undefined starts a new conversation. */
  conversationId?: string;
  question: string;
  sourceIds: string[];
}

export function useQueryRunner() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  return useMemo(() => {
    const ask = ({ conversationId, question, sourceIds }: AskInput) => {
      const key = conversationId ?? NEW_CONVERSATION;
      const now = new Date().toISOString();
      const userMessage: UserMessage = { id: crypto.randomUUID(), role: 'user', content: question, createdAt: now };
      const assistant: AssistantMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        status: 'running',
        stage: 'understanding',
        createdAt: now,
      };
      updateConversation(qc, key, (conversation) => ({
        ...conversation,
        title: conversation.messages.length ? conversation.title : question.slice(0, 80),
        updatedAt: now,
        messages: [...conversation.messages, userMessage, assistant],
      }));
      void runStream({
        qc,
        path: queryPaths.ask,
        body: { conversationId, question, sourceIds },
        conversationKey: key,
        messageId: assistant.id,
        onConversationCreated: (id) => {
          // Only move the URL if the user is still looking at the new conversation.
          if (window.location.pathname === '/ask') navigate(`/ask/${encodeURIComponent(id)}`, { replace: true });
        },
      });
    };

    const clarify = (key: string, message: AssistantMessage, option: { id: string; label: string }) => {
      if (!message.queryId) return;
      patchMessage(qc, key, message.id, { status: 'running', stage: 'building', clarificationAnswer: option.label });
      void runStream({
        qc,
        path: queryPaths.clarify(message.queryId),
        body: { optionId: option.id },
        conversationKey: key,
        messageId: message.id,
      });
    };

    const confirm = (key: string, message: AssistantMessage) => {
      if (!message.queryId) return;
      patchMessage(qc, key, message.id, { status: 'running', stage: 'running' });
      void runStream({
        qc,
        path: queryPaths.confirm(message.queryId),
        body: {},
        conversationKey: key,
        messageId: message.id,
      });
    };

    const refresh = (key: string, message: AssistantMessage) => {
      if (!message.answer) return;
      patchMessage(qc, key, message.id, { refreshing: true, stage: 'understanding' });
      void runStream({
        qc,
        path: queryPaths.refresh(message.answer.queryId),
        body: {},
        conversationKey: key,
        messageId: message.id,
        refresh: true,
      });
    };

    const cancel = (key: string, message: AssistantMessage) => {
      const stream = activeStreams.get(message.id);
      stream?.controller.abort();
      activeStreams.delete(message.id);
      const queryId = stream?.queryId ?? message.queryId;
      if (queryId) void cancelQuery(queryId).catch(() => undefined);
      const conversationKey = stream?.conversationKey ?? key;
      if (message.refreshing) patchMessage(qc, conversationKey, message.id, { refreshing: false, stage: undefined });
      else patchMessage(qc, conversationKey, message.id, { status: 'cancelled', stage: undefined });
    };

    return { ask, clarify, confirm, refresh, cancel };
  }, [qc, navigate]);
}

export type QueryRunner = ReturnType<typeof useQueryRunner>;
