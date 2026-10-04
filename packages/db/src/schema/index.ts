/**
 * Product store schema.
 *
 * Tables are grouped by domain module so the modular monolith's boundaries are
 * visible in the persistence layer too.
 *
 * Hard rule (Master Spec §4): this store holds product configuration only.
 * No Matomo analytics result sets, no visit/action raw data, no analytics API
 * payloads. Adding such a table requires an explicit deviation record.
 */
export * from './platform';
export * from './identity';
export * from './tenancy';
export * from './access';
export * from './matomo';
export * from './semantic';
export * from './dashboard';
export * from './audit';
export * from './solution';
export * from './sharing';
export * from './reporting';
export * from './productization';
