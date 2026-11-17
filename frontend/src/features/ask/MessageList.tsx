import { CornerDownRight } from 'lucide-react';
import type { Answer, AssistantMessage, Message } from '@/api/types';
import { AnswerCard } from './AnswerCard';
import { ClarifyCard, ConfirmCard } from './DecisionCards';
import { ErrorCard } from './ErrorCard';
import { ProgressSteps } from './ProgressSteps';
import type { QueryRunner } from './runner';

interface MessageListProps {
  conversationKey: string;
  messages: Message[];
  runner: QueryRunner;
  onAsk: (question: string) => void;
}

function hasAnswer(message: AssistantMessage): message is AssistantMessage & { answer: Answer } {
  return message.answer !== undefined;
}

export function MessageList({ conversationKey, messages, runner, onAsk }: MessageListProps) {
  let lastQuestion = '';
  return (
    <ol className="space-y-6" aria-label="Conversation">
      {messages.map((message) => {
        if (message.role === 'user') {
          lastQuestion = message.content;
          return (
            <li key={message.id} className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-fg">
                <span className="sr-only">You asked: </span>
                {message.content}
              </p>
            </li>
          );
        }
        const question = lastQuestion;
        return (
          <li key={message.id} className="space-y-2">
            {message.clarificationAnswer && (
              <p className="flex items-center gap-1.5 text-sm text-fg-secondary">
                <CornerDownRight className="size-4" aria-hidden="true" />
                You chose: <span className="font-medium text-fg">{message.clarificationAnswer}</span>
              </p>
            )}
            <AssistantTurn
              message={message}
              conversationKey={conversationKey}
              runner={runner}
              question={question}
              onAsk={onAsk}
            />
          </li>
        );
      })}
    </ol>
  );
}

function AssistantTurn({
  message,
  conversationKey,
  runner,
  question,
  onAsk,
}: {
  message: AssistantMessage;
  conversationKey: string;
  runner: QueryRunner;
  question: string;
  onAsk: (question: string) => void;
}) {
  const cancel = () => runner.cancel(conversationKey, message);
  const retry = question ? () => onAsk(question) : undefined;

  switch (message.status) {
    case 'running':
      if (message.refreshing && hasAnswer(message)) break;
      return <ProgressSteps stage={message.stage} onCancel={cancel} />;
    case 'needs_clarification':
      return message.clarification ? (
        <ClarifyCard
          clarification={message.clarification}
          onChoose={(option) => runner.clarify(conversationKey, message, option)}
          onCancel={cancel}
        />
      ) : null;
    case 'needs_confirmation':
      return message.confirmation ? (
        <ConfirmCard
          confirmation={message.confirmation}
          onConfirm={() => runner.confirm(conversationKey, message)}
          onCancel={cancel}
        />
      ) : null;
    case 'error':
      return message.error ? <ErrorCard error={message.error} onRetry={retry} /> : null;
    case 'cancelled':
      return <p className="text-sm text-fg-secondary">You cancelled this question.</p>;
    case 'done':
      break;
  }

  if (!hasAnswer(message)) return null;
  return (
    <AnswerCard
      message={message}
      onRefresh={() => runner.refresh(conversationKey, message)}
      onCancelRefresh={cancel}
      onFollowUp={onAsk}
    />
  );
}
