import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { getPreferences, listSources, updatePreferences } from '@/api/endpoints';
import { qk } from '@/api/queryKeys';
import type { Preferences } from '@/api/types';

export function useSources() {
  return useQuery({ queryKey: qk.sources, queryFn: listSources, staleTime: 60_000 });
}

export function usePreferences() {
  return useQuery({ queryKey: qk.preferences, queryFn: getPreferences, staleTime: 5 * 60_000 });
}

export function useUpdatePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: updatePreferences,
    onMutate: async (next: Preferences) => {
      await qc.cancelQueries({ queryKey: qk.preferences });
      const previous = qc.getQueryData<Preferences>(qk.preferences);
      qc.setQueryData(qk.preferences, next);
      return { previous };
    },
    onError: (error, _next, context) => {
      if (context?.previous) qc.setQueryData(qk.preferences, context.previous);
      toast.error("Couldn't save your settings", { description: errorMessage(error) });
    },
    onSuccess: (saved) => qc.setQueryData(qk.preferences, saved),
  });
}
