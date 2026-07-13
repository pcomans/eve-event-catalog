const BEARER_PREFIX = "Bearer ";

/**
 * True only for an exact "Bearer <secret>" match against the configured
 * CATALOG_API_SECRET. A plain string comparison (not timing-safe) — this is
 * a single shared secret guarding a POC's write routes, not a
 * multi-tenant credential; see AT-10 for the auth convention.
 */
export function isAuthorizedHeader(header: string | null, secret: string): boolean {
  if (!secret || !header || !header.startsWith(BEARER_PREFIX)) return false;
  return header.slice(BEARER_PREFIX.length) === secret;
}

/**
 * Fail-closed boot check, in the spirit of assertCatalogHonesty (catalog.ts):
 * POST /catalog/chat and POST /catalog/wake require a shared secret, so
 * booting without CATALOG_API_SECRET configured would silently run those
 * write routes unauthenticated. Refuse to boot instead.
 */
export function assertCatalogApiSecretConfigured(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.CATALOG_API_SECRET) {
    throw new Error(
      "CATALOG_API_SECRET is not set. POST /catalog/chat and POST /catalog/wake require " +
        "'authorization: Bearer $CATALOG_API_SECRET' (see .env.example) — the server refuses to boot " +
        "rather than silently running those write routes unauthenticated.",
    );
  }
}
