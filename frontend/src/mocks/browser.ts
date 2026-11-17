import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

/** Starts the in-browser mock API. Only imported when VITE_USE_MOCKS=true. */
export async function startMockBackend() {
  const worker = setupWorker(...handlers);
  await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
}
