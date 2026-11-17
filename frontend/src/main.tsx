import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/App';
import '@/index.css';

async function start() {
  // Written inline (not via a helper) so production builds drop the mock backend entirely.
  if (import.meta.env.VITE_USE_MOCKS === 'true') {
    const { startMockBackend } = await import('@/mocks/browser');
    await startMockBackend();
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root element');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
