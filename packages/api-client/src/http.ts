import { ERROR_MESSAGES_FR } from '@try/contracts';
import type { ApiErrorBody, ErrorCode } from '@try/contracts';

/**
 * The one place any TRY frontend talks to the API.
 *
 * Nothing in a screen calls `fetch` directly: that is how untyped responses,
 * inconsistent error handling and forgotten auth headers spread through an app.
 */

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly requestId: string | null,
    readonly details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Retrying can plausibly succeed: transport failures and 5xx, never a 4xx. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.code === 'SERVICE_UNAVAILABLE';
  }

  /** The user must sign in again. */
  get isAuthError(): boolean {
    return this.code === 'UNAUTHENTICATED';
  }
}

export interface TokenStore {
  getAccessToken(): string | null | Promise<string | null>;
  getRefreshToken(): string | null | Promise<string | null>;
  setTokens(tokens: { accessToken: string; refreshToken: string; expiresIn: number }): Promise<void>;
  clear(): Promise<void>;
}

export interface ApiClientOptions {
  baseUrl: string;
  tokens?: TokenStore;
  /** Called after refresh definitively fails, so the app can route to sign-in. */
  onUnauthenticated?: () => void;
  defaultTimeoutMs?: number;
  /** App version and platform, for server-side diagnostics. */
  clientInfo?: { name: string; version: string };
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  /** Required by the API on booking creation and other money-moving calls. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Skips the Authorization header (login endpoints). */
  anonymous?: boolean;
}

export class ApiClient {
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(private readonly options: ApiClientOptions) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(path, options);

    /**
     * A single retry after a successful refresh. Concurrent 401s share one
     * refresh promise, so a screen firing five queries at once does not rotate
     * the refresh token five times — which would trip reuse detection and log
     * the user out.
     */
    if (response.status === 401 && !options.anonymous && this.options.tokens) {
      const refreshed = await this.refreshOnce();
      if (refreshed) return this.parse<T>(await this.send(path, options));

      await this.options.tokens.clear();
      this.options.onUnauthenticated?.();
    }

    return this.parse<T>(response);
  }

  get<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  patch<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }

  delete<T>(path: string, options: Omit<RequestOptions, 'method'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }

  private async send(path: string, options: RequestOptions): Promise<Response> {
    const url = this.buildUrl(path, options.query);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      ...(this.options.clientInfo
        ? { 'X-Client': `${this.options.clientInfo.name}/${this.options.clientInfo.version}` }
        : {}),
    };

    if (!options.anonymous && this.options.tokens) {
      const token = await this.options.tokens.getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    // A hung request on a train through the Belgian countryside must not leave a
    // spinner forever; the timeout composes with any caller-supplied signal.
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.options.defaultTimeoutMs ?? 15_000,
    );
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      return await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      // Status 0 marks "never reached the server", which the UI phrases as a
      // connectivity problem rather than a server error.
      throw new ApiError(
        'SERVICE_UNAVAILABLE',
        'Connexion impossible. Vérifie ta connexion internet.',
        0,
        null,
        error instanceof Error ? { network: [error.message] } : undefined,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parse<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const payload: unknown = text ? safeJsonParse(text) : null;

    if (!response.ok) {
      const body = (payload ?? {}) as Partial<ApiErrorBody>;
      const code = (body.code ?? 'INTERNAL_ERROR') as ErrorCode;
      throw new ApiError(
        code,
        body.message ?? ERROR_MESSAGES_FR[code] ?? 'Une erreur est survenue.',
        response.status,
        body.requestId ?? response.headers.get('x-request-id'),
        body.details,
      );
    }

    return payload as T;
  }

  /** Deduplicates concurrent refreshes; see the note in `request`. */
  private refreshOnce(): Promise<boolean> {
    this.refreshInFlight ??= this.performRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<boolean> {
    const store = this.options.tokens;
    if (!store) return false;

    const refreshToken = await store.getRefreshToken();
    if (!refreshToken) return false;

    try {
      const response = await fetch(this.buildUrl('/v1/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) return false;

      const session = (await response.json()) as {
        tokens: { accessToken: string; refreshToken: string; expiresIn: number };
      };
      await store.setTokens(session.tokens);
      return true;
    } catch {
      return false;
    }
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | string[] | undefined>,
  ): string {
    const base = this.options.baseUrl.replace(/\/$/, '');
    const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        // Repeated keys, matching the array coercion in the Zod query schemas.
        for (const entry of value) url.searchParams.append(key, entry);
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
