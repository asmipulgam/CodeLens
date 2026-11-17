/**
 * End-to-end flow against the mock backend (MSW in Node): sign in, ask questions, see live and
 * cached answers, hidden queries for business users, and an access-denied answer.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '@/mocks/handlers';
import { App, queryClient } from './App';
import { router } from './router';

const server = setupServer(...handlers);
let restoreFetch: typeof fetch | undefined;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  // Node's fetch needs absolute URLs; the app uses relative /api paths like a browser would.
  const intercepted = globalThis.fetch;
  restoreFetch = intercepted;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    intercepted(
      typeof input === 'string' && input.startsWith('/') ? new URL(input, window.location.origin).toString() : input,
      init,
    )) as typeof fetch;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

afterAll(() => {
  if (restoreFetch) globalThis.fetch = restoreFetch;
  server.close();
});

async function ask(user: ReturnType<typeof userEvent.setup>, question: string) {
  const input = screen.getByLabelText('Ask a question about your data');
  await user.clear(input);
  await user.type(input, `${question}{Enter}`);
}

describe('CodeLens app', () => {
  it('signs in, answers questions, uses the cache and enforces access', { timeout: 30_000 }, async () => {
    window.history.pushState({}, '', '/ask');
    const user = userEvent.setup();
    render(<App />);

    // Not signed in → login page with the demo role picker.
    await user.click(await screen.findByRole('button', { name: /Business user/ }));
    expect(await screen.findByText(/Hi Priya, what would you like to know/)).toBeInTheDocument();

    // First question → live answer.
    await ask(user, 'What were total sales by region last month?');
    const firstAnswer = await screen.findByRole('article', { name: 'Answer' }, { timeout: 10_000 });
    expect(within(firstAnswer).getByText(/across 5 regions/)).toBeInTheDocument();
    expect(within(firstAnswer).getByText(/^Live ·/)).toBeInTheDocument();

    // Business users never receive the generated SQL, so they get no "Show query" switch either.
    expect(screen.queryByText(/SELECT r\.region_name/)).not.toBeInTheDocument();
    expect(within(firstAnswer).queryByRole('switch', { name: 'Show query' })).not.toBeInTheDocument();
    // …and can't export.
    expect(within(firstAnswer).queryByRole('button', { name: /Export CSV/ })).not.toBeInTheDocument();

    // Same question again → served from cache.
    await ask(user, 'What were total sales by region last month?');
    await waitFor(() => expect(screen.getAllByRole('article', { name: 'Answer' })).toHaveLength(2), { timeout: 10_000 });
    const second = screen.getAllByRole('article', { name: 'Answer' })[1];
    expect(within(second).getByText(/Cached/)).toBeInTheDocument();

    // A source the role can't access → clear message with "Request access".
    await ask(user, 'What is our headcount by department?');
    expect(await screen.findByText("You don't have access to this data", {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeInTheDocument();

    // Write attempts are refused.
    await ask(user, 'Delete all cancelled orders please');
    expect(await screen.findByText('CodeLens can only read data', {}, { timeout: 10_000 })).toBeInTheDocument();
  });

  it('lets analysts show or hide the generated query', { timeout: 30_000 }, async () => {
    // Switch the demo session to the analyst role.
    await fetch('/api/auth/logout', { method: 'POST' });
    await fetch('/api/auth/demo-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'analyst' }),
    });
    // The router lives for the whole test file; send it back to a fresh question page.
    await router.navigate('/ask');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText(/Hi Marcus, what would you like to know/, {}, { timeout: 5_000 })).toBeInTheDocument();

    await ask(user, 'What were total sales by region last month?');
    const answer = await screen.findByRole('article', { name: 'Answer' }, { timeout: 10_000 });
    const toggle = await within(answer).findByRole('switch', { name: 'Show query' });

    if (toggle.getAttribute('aria-checked') === 'true') await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(within(answer).queryByText(/SELECT/)).not.toBeInTheDocument();

    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(within(answer).getByText(/SELECT/)).toBeInTheDocument();

    await user.click(toggle);
    await waitFor(() => expect(within(answer).queryByText(/SELECT/)).not.toBeInTheDocument());
  });
});
