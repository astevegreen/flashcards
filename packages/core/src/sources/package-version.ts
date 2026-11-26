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
