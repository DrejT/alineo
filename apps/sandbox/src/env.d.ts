/// <reference types="astro/client" />

interface ImportMetaEnv {
  /**
   * Base URL for the Bun API/WS backend, e.g. "https://sandbox-api.alineo.tech".
   * Leave unset for local dev, where the frontend and backend share an origin.
   */
  readonly PUBLIC_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
