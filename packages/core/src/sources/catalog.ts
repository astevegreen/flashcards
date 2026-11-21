import {
  isStrictHttpsUrl,
  validateFamilyCatalog,
  type FamilyCatalog,
  type SchemaValidationError,
} from '@flash/content-schema';

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

/**
 * Semver-aware version comparison (`> 0` if `a > b`, `< 0` if `a < b`, `0` if equal).
 */
export function comparePackageVersions(a: string, b: string): number {
  const cleanA = a.trim().replace(/^v/i, '');
  const cleanB = b.trim().replace(/^v/i, '');
  if (cleanA === cleanB) return 0;

  const [coreA = '', preA = ''] = cleanA.split('-', 2);
  const [coreB = '', preB = ''] = cleanB.split('-', 2);

  const partsA = coreA.split('.');
  const partsB = coreB.split('.');
  const maxLen = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLen; i++) {
    const segA = partsA[i] ?? '0';
    const segB = partsB[i] ?? '0';
    const numA = /^\d+$/.test(segA) ? Number(segA) : NaN;
    const numB = /^\d+$/.test(segB) ? Number(segB) : NaN;
    if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
      if (numA !== numB) return numA - numB;
    } else if (segA !== segB) {
      return segA < segB ? -1 : 1;
    }
  }

  // Stable release > prerelease
  if (preA === '' && preB !== '') return 1;
  if (preA !== '' && preB === '') return -1;
  if (preA === preB) return 0;
  return preA < preB ? -1 : 1;
}

export function shouldUpgradePackage(
  currentVersion: string | undefined,
  remoteVersion: string,
): boolean {
  if (!currentVersion) return true;
  return comparePackageVersions(remoteVersion, currentVersion) > 0;
}
