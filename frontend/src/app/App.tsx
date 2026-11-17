import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { ApiError } from '@/api/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { router } from './router';
import { ThemeProvider, useTheme } from './theme';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Data lives in memory only and is wiped on sign-out. Nothing is persisted to disk.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status > 0 && error.status < 500) return false;
          return failureCount < 1;
        },
      },
      mutations: { retry: false },
    },
  });
}

/** Exported so tests can start each scenario with an empty cache. */
export const queryClient = createQueryClient();

function ThemedToaster() {
  const { resolved } = useTheme();
  return <Toaster theme={resolved} position="bottom-right" closeButton richColors />;
}

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300}>
          <RouterProvider router={router} />
          <ThemedToaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
