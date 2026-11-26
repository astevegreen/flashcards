import {
  isStrictHttpsUrl,
  validateFamilyCatalog,
  type FamilyCatalog,
  type SchemaValidationError,
} from '@flash/content-schema';

// Version comparison lives on its own so the starter-deck upgrade can use it without the schemas.
export { comparePackageVersions, shouldUpgradePackage } from './package-version.ts';

export const FAMILY_CATALOG_LIMITS = {
  maxCatalogBytes: 1 * 1024 * 1024, // 1 MB
  maxPackages: 500,
} as const;

export class CatalogValidationError extends Error {
  readonly errors: SchemaValidationError[];
  constructor(message: string, errors: SchemaValidationError[] = []) {
    super(message);
    this.name = 'CatalogValidationError';
    this.errors = errors;
  }
}

/**
 * Strictly validates that a URL uses `https:` with a valid host and zero embedded credentials (§13).
 * Returns trimmed URL with lowercase `https://` prefix.
 */
export function assertSafeHttpsUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!isStrictHttpsUrl(trimmed)) {
    throw new CatalogValidationError(
      `Unsafe or invalid URL "${rawUrl}". Only https:// URLs without credentials are allowed.`,
    );
  }
  return `https://${trimmed.slice(8)}`;
}

/**
 * Validates raw JSON text for a Family Library `index.json` catalog (§3.4, §13).
 * Enforces byte cap, Zod schema validation, strict `https:` URLs, and unique `package_id`s.
 */
export function parseAndValidateFamilyCatalog(rawJson: string): FamilyCatalog {
  if (rawJson.length > FAMILY_CATALOG_LIMITS.maxCatalogBytes) {
    throw new CatalogValidationError(
      `Family catalog exceeds max size (${FAMILY_CATALOG_LIMITS.maxCatalogBytes} bytes).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new CatalogValidationError(
      `Invalid Family Library catalog JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const res = validateFamilyCatalog(parsed);
  if (!res.ok) {
    throw new CatalogValidationError('Invalid Family Library index.json manifest.', res.errors);
  }

  if (res.data.packages.length > FAMILY_CATALOG_LIMITS.maxPackages) {
    throw new CatalogValidationError(
      `Family catalog exceeds maximum package limit (${FAMILY_CATALOG_LIMITS.maxPackages}).`,
    );
  }

  const seenIds = new Set<string>();
  for (const entry of res.data.packages) {
    if (seenIds.has(entry.package_id)) {
      throw new CatalogValidationError(
        `Duplicate package_id "${entry.package_id}" in Family Library catalog.`,
      );
    }
    seenIds.add(entry.package_id);
    assertSafeHttpsUrl(entry.url);
  }

  return res.data;
}
