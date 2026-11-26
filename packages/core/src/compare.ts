/**
 * Code-unit string order (not localeCompare): queues and lists must be identical on every device
 * and locale. The shared comparator for sorting names and ids.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
