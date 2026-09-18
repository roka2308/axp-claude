/**
 * @axp/contracts - the canonical vocabulary of the product.
 *
 * Mirrors `02_Shared_Product_Engineering_Contract_v1.0.md`. Both the API and the
 * web app depend on this package so terminology cannot drift between layers.
 * Changing a name here is a contract change and needs an ADR.
 */
export * from './ids';
export * from './roles';
export * from './scopes';
export * from './lifecycle';
export * from './states';
export * from './errors';
export * from './identity';
export * from './audit';
export * from './api';
