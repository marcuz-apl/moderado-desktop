export type SearchProvider = 'custom' | 'brave' | 'tavily' | 'serper' | 'searxng';

export const SEARCH_PROVIDERS: readonly SearchProvider[] = ['custom', 'brave', 'tavily', 'serper', 'searxng'];

export function toSearchProvider(value: unknown): SearchProvider {
  return SEARCH_PROVIDERS.includes(value as SearchProvider) ? (value as SearchProvider) : 'custom';
}

/** Hosted APIs authenticate with a key the user supplies. */
export function needsKey(provider: SearchProvider): boolean {
  return provider === 'brave' || provider === 'tavily' || provider === 'serper';
}

/** Custom endpoints and self-hosted SearXNG have no default URL. */
export function requiresEndpoint(provider: SearchProvider): boolean {
  return provider === 'custom' || provider === 'searxng';
}

export function endpointField(provider: SearchProvider): { label: string; placeholder: string } {
  switch (provider) {
    case 'brave':
      return { label: 'Endpoint (optional)', placeholder: 'https://api.search.brave.com/res/v1/web/search' };
    case 'tavily':
      return { label: 'Endpoint (optional)', placeholder: 'https://api.tavily.com/search' };
    case 'serper':
      return { label: 'Endpoint (optional)', placeholder: 'https://google.serper.dev/search' };
    case 'searxng':
      return { label: 'SearXNG URL', placeholder: 'https://searx.example.com' };
    default:
      return { label: 'Search API endpoint', placeholder: 'https://search.example/api' };
  }
}

/** Mirrors `search::is_configured` in Rust so the UI and the agent agree. */
export function isSearchConfigured(provider: SearchProvider, endpoint: string, hasKey: boolean): boolean {
  if (requiresEndpoint(provider) && !endpoint.trim()) return false;
  if (needsKey(provider) && !hasKey) return false;
  return true;
}

/** Returns a message for invalid input, or null when the settings can be saved. */
export function validateSearchInput(provider: SearchProvider, endpoint: string, key: string): string | null {
  if (requiresEndpoint(provider) && !endpoint.trim()) {
    return provider === 'searxng' ? 'Enter the SearXNG URL before saving.' : 'Enter a search endpoint before saving.';
  }
  if (needsKey(provider) && !key) return 'Enter an API key before saving.';
  return null;
}

export function searchStatus(provider: SearchProvider, endpoint: string, hasKey: boolean): string {
  if (isSearchConfigured(provider, endpoint, hasKey)) return 'Web search is available for this session.';
  if (needsKey(provider)) return 'Saved, but web search needs an API key before the agent can use it.';
  return 'Saved, but web search needs an endpoint before the agent can use it.';
}
