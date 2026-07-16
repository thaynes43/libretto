/** Minimal fetch helpers shared by the target and source clients. */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodyExcerpt: string,
  ) {
    super(`HTTP ${status} from ${url}${bodyExcerpt ? `: ${bodyExcerpt}` : ''}`);
  }
}

export interface JsonRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * JSON round-trip with honest errors: non-2xx throws HttpError carrying the
 * status and a body excerpt (Kavita and ABS both put the reason there). A 204 or
 * an empty body resolves to undefined.
 */
export async function fetchJson<T>(url: string, request: JsonRequest = {}): Promise<T> {
  const response = await fetch(url, {
    method: request.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...request.headers,
    },
    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(response.status, url, text.slice(0, 300));
  }
  return (text.length === 0 ? undefined : JSON.parse(text)) as T;
}

/** Join a base URL and a path without double slashes. */
export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`);
}
