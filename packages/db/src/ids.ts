import { v7 as uuidv7 } from 'uuid';

/**
 * Primary keys are UUIDv7: globally unique, time-ordered (good InnoDB index
 * locality) and readable in logs and support cases.
 *
 * These are local database ids. Portable ids used by solution packages are a
 * separate concept and must never be derived from them (Shared Contract §13).
 */
export function newId(): string {
  return uuidv7();
}

export const ID_LENGTH = 36;
