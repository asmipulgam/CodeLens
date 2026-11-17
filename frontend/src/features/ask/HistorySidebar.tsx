import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, History, MoreHorizontal, Pencil, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import {
  deleteConversation,
  deleteSavedQuestion,
  listConversations,
  listSavedQuestions,
  updateConversation,
} from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import type { ConversationSummary, SavedQuestion } from '@/api/types';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { EmptyState, Skeleton } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/cn';

interface HistorySidebarProps {
  activeId?: string;
  onNewQuestion: () => void;
  onAskSaved: (saved: SavedQuestion) => void;
  onNavigate?: () => void;
  className?: string;
}

function groupConversations(items: ConversationSummary[]) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const weekAgo = startOfToday.getTime() - 7 * 86_400_000;
  const groups: { label: string; items: ConversationSummary[] }[] = [
    { label: 'Pinned', items: [] },
    { label: 'Today', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Older', items: [] },
  ];
  const sorted = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const item of sorted) {
    const time = new Date(item.updatedAt).getTime();
    if (item.pinned) groups[0].items.push(item);
    else if (time >= startOfToday.getTime()) groups[1].items.push(item);
    else if (time >= weekAgo) groups[2].items.push(item);
    else groups[3].items.push(item);
  }
  return groups.filter((group) => group.items.length > 0);
}

export function HistorySidebar({ activeId, onNewQuestion, onAskSaved, onNavigate, className }: HistorySidebarProps) {
  const [search, setSearch] = useState('');
  const conversations = useQuery({ queryKey: qk.conversations, queryFn: listConversations });
  const saved = useQuery({ queryKey: qk.saved, queryFn: listSavedQuestions });

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const items = conversations.data ?? [];
    return term ? items.filter((item) => item.title.toLowerCase().includes(term)) : items;
  }, [conversations.data, search]);

  const groups = useMemo(() => groupConversations(filtered), [filtered]);

  return (
    <aside className={cn('flex w-72 shrink-0 flex-col border-r border-line bg-surface', className)} aria-label="Conversations">
      <div className="space-y-3 p-3">
        <Button className="w-full justify-start" onClick={onNewQuestion}>
          <Plus aria-hidden="true" /> New question
        </Button>
      </div>
      <Tabs defaultValue="history" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-3 grid grid-cols-2">
          <TabsTrigger value="history" className="justify-center">
            <History aria-hidden="true" /> History
          </TabsTrigger>
          <TabsTrigger value="saved" className="justify-center">
            <Bookmark aria-hidden="true" /> Saved
          </TabsTrigger>
        </TabsList>

        <TabsContent value="history" className="mt-3 flex min-h-0 flex-1 flex-col">
          <div className="relative px-3 pb-2">
            <Search className="pointer-events-none absolute left-5 top-2.5 size-4 text-fg-muted" aria-hidden="true" />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
              className="pl-8"
            />
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Conversation history">
            {conversations.isPending ? (
              <div className="space-y-2 px-1">
                {Array.from({ length: 6 }, (_, index) => (
                  <Skeleton key={index} className="h-8" />
                ))}
              </div>
            ) : groups.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-fg-secondary">
                {search ? 'No conversations match your search.' : 'Your questions will appear here.'}
              </p>
            ) : (
              groups.map((group) => (
                <section key={group.label} className="mb-3">
                  <h3 className="px-2 pb-1 text-xs font-medium text-fg-secondary">{group.label}</h3>
                  <ul className="space-y-0.5">
                    {group.items.map((item) => (
                      <ConversationItem key={item.id} item={item} active={item.id === activeId} onNavigate={onNavigate} />
                    ))}
                  </ul>
                </section>
              ))
            )}
          </nav>
        </TabsContent>

        <TabsContent value="saved" className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {saved.isPending ? (
            <div className="space-y-2 px-1">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-10" />
              ))}
            </div>
          ) : !saved.data?.length ? (
            <EmptyState
              icon={<Bookmark />}
              title="No saved questions yet"
              description="Use “Save” on an answer to keep questions you ask often."
              className="py-8"
            />
          ) : (
            <ul className="space-y-1">
              {saved.data.map((item) => (
                <SavedItem key={item.id} item={item} onAsk={onAskSaved} />
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function ConversationItem({
  item,
  active,
  onNavigate,
}: {
  item: ConversationSummary;
  active: boolean;
  onNavigate?: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const update = useMutation({
    mutationFn: (patch: { title?: string; pinned?: boolean }) => updateConversation(item.id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.conversations }),
    onError: (error) => toast.error("Couldn't update conversation", { description: errorMessage(error) }),
  });

  const remove = useMutation({
    mutationFn: () => deleteConversation(item.id),
    onSuccess: () => {
      qc.removeQueries({ queryKey: qk.conversation(item.id) });
      void qc.invalidateQueries({ queryKey: qk.conversations });
      setConfirmDelete(false);
      if (active) navigate('/ask');
    },
    onError: (error) => toast.error("Couldn't delete conversation", { description: errorMessage(error) }),
  });

  const saveTitle = () => {
    const next = title.trim();
    setRenaming(false);
    if (next && next !== item.title) update.mutate({ title: next });
    else setTitle(item.title);
  };

  if (renaming) {
    return (
      <li className="px-1">
        <Input
          autoFocus
          value={title}
          maxLength={120}
          aria-label="Conversation name"
          onChange={(event) => setTitle(event.target.value)}
          onBlur={saveTitle}
          onKeyDown={(event) => {
            if (event.key === 'Enter') saveTitle();
            if (event.key === 'Escape') {
              setTitle(item.title);
              setRenaming(false);
            }
          }}
          className="h-8"
        />
      </li>
    );
  }

  return (
    <li className="group relative">
      <NavLink
        to={`/ask/${encodeURIComponent(item.id)}`}
        onClick={onNavigate}
        className={cn(
          'block truncate rounded-md py-1.5 pl-2 pr-8 text-sm text-fg-secondary hover:bg-wash hover:text-fg',
          active && 'bg-wash font-medium text-fg',
        )}
        title={item.title}
      >
        {item.pinned && <Pin className="mr-1 inline size-3" aria-label="Pinned" />}
        {item.title}
      </NavLink>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="absolute right-1 top-1 rounded p-1 text-fg-secondary opacity-0 hover:bg-line focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
            aria-label={`Options for ${item.title}`}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => update.mutate({ pinned: !item.pinned })}>
            {item.pinned ? <PinOff /> : <Pin />} {item.pinned ? 'Unpin' : 'Pin'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => setConfirmDelete(true)}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this conversation?"
        description="It will be removed from your history. The audit log keeps its own record for security."
        confirmLabel="Delete"
        destructive
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </li>
  );
}

function SavedItem({ item, onAsk }: { item: SavedQuestion; onAsk: (saved: SavedQuestion) => void }) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteSavedQuestion(item.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.saved }),
    onError: (error) => toast.error("Couldn't remove saved question", { description: errorMessage(error) }),
  });
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => onAsk(item)}
        className="block w-full rounded-md py-2 pl-2 pr-8 text-left text-sm text-fg-secondary hover:bg-wash hover:text-fg"
      >
        {item.question}
      </button>
      <button
        type="button"
        onClick={() => remove.mutate()}
        className="absolute right-1 top-1.5 rounded p-1 text-fg-secondary opacity-0 hover:bg-line focus:opacity-100 group-hover:opacity-100"
        aria-label={`Remove saved question: ${item.question}`}
      >
        <Trash2 className="size-4" />
      </button>
    </li>
  );
}
