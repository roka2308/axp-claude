/**
 * Number of rows an INSERT/UPDATE/DELETE touched.
 *
 * The mysql2 driver returns `[ResultSetHeader, FieldPacket[]]`, so the count
 * lives in the first tuple element rather than on the result object. Reading it
 * off the wrong level silently yields 0 — which looks like "nothing matched"
 * instead of a bug, so it is worth having one helper rather than casts spread
 * across the domain layer.
 */
export function affectedRows(result: unknown): number {
  if (Array.isArray(result)) {
    const header = result[0] as { affectedRows?: number } | undefined;
    return Number(header?.affectedRows ?? 0);
  }
  return Number((result as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}
