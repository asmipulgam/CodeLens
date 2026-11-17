/**
 * Cross-tab auth signals. Logging out in one tab logs out every tab, and activity in one
 * tab keeps the others from timing out. Only signal names travel here — never data.
 */
export type AuthSignal = { type: 'logout'; reason: string } | { type: 'activity'; at: number };

const CHANNEL = 'codelens-auth';

export function createAuthChannel(onSignal: (signal: AuthSignal) => void) {
  if (typeof BroadcastChannel === 'undefined') {
    return { post: (_signal: AuthSignal) => undefined, close: () => undefined };
  }
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<AuthSignal>) => {
    const data = event.data;
    if (data && (data.type === 'logout' || data.type === 'activity')) onSignal(data);
  };
  return {
    post: (signal: AuthSignal) => channel.postMessage(signal),
    close: () => channel.close(),
  };
}

export function broadcastLogout(reason: string) {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ type: 'logout', reason } satisfies AuthSignal);
  channel.close();
}
