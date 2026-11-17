/**
 * Thin fetch wrapper for the CodeLens API.
 *
 * Security model: the backend (BFF) owns the identity-provider tokens. The browser only holds
 * an HttpOnly, Secure, SameSite=Strict session cookie, which JavaScript cannot read. A CSRF token
 * from the session endpoint is kept in memory and sent on every state-changing request.
 */

export const API_BASE = '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

type UnauthorizedHandler = (error: ApiError) => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** Called when any request (other than the session check) returns 401. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null) {
  unauthorizedHandler = handler;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function defaultCode(status: number): string {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'request_failed';
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const record = (body ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof record.code === 'string' ? record.code : defaultCode(response.status);
  const message =
    typeof record.message === 'string'
      ? record.message
      : response.status >= 500
        ? 'Something went wrong on our side. Please try again.'
        : 'The request could not be completed.';
  return new ApiError(response.status, code, message, body);
}

export interface ApiRequestInit extends Omit<RequestInit, 'body'> {
  json?: unknown;
  body?: BodyInit | null;
}

export async function apiFetch(path: string, init: ApiRequestInit = {}): Promise<Response> {
  const { json, ...rest } = init;
  const method = (rest.method ?? 'GET').toUpperCase();
  const headers = new Headers(rest.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  headers.set('X-Requested-With', 'XMLHttpRequest');

  let body = rest.body;
  if (json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(json);
  }
  if (!SAFE_METHODS.has(method) && csrfToken) headers.set('X-CSRF-Token', csrfToken);

  let response: Response;
  try {
    response = await fetch(API_BASE + path, {
      ...rest,
      method,
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network_error', 'Cannot reach CodeLens. Check your connection and try again.');
  }

  if (!response.ok) {
    const error = await toApiError(response);
    if (response.status === 401 && !path.startsWith('/auth/session')) unauthorizedHandler?.(error);
    throw error;
  }
  return response;
}

export async function apiJson<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiJson<T>(path, { signal }),
  post: <T>(path: string, json?: unknown) => apiJson<T>(path, { method: 'POST', json: json ?? {} }),
  put: <T>(path: string, json: unknown) => apiJson<T>(path, { method: 'PUT', json }),
  patch: <T>(path: string, json: unknown) => apiJson<T>(path, { method: 'PATCH', json }),
  delete: <T = void>(path: string) => apiJson<T>(path, { method: 'DELETE' }),
};

export function isApiError(error: unknown, code?: string): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
