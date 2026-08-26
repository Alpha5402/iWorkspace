import { ErrorResponseSchema, type ErrorResponse } from '@delivery/contracts';

export class ApiClientError extends Error {
  public constructor(
    public readonly status: number,
    public readonly response: ErrorResponse,
  ) {
    super(response.error.message);
    this.name = 'ApiClientError';
  }
}

export type ApiClient = Readonly<{
  getCapability(path: string): Promise<never>;
}>;

export function createApiClient(
  fetchImplementation: typeof fetch = fetch,
  baseUrl: string = import.meta.env.VITE_API_BASE_URL ?? '/api/v1',
): ApiClient {
  return {
    async getCapability(path: string): Promise<never> {
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      const response = await fetchImplementation(`${baseUrl}${normalizedPath}`, {
        headers: { accept: 'application/json' },
      });
      const body: unknown = await response.json();
      const error = ErrorResponseSchema.parse(body);
      throw new ApiClientError(response.status, error);
    },
  };
}
