/**
 * Product search (D1).
 *
 * One hit is one product object the caller may open. There is deliberately no
 * analytics kind here: the top-bar search finds things in the product, it does
 * not answer questions about the data (D1 excludes Search/Interests).
 */
export const PRODUCT_SEARCH_KINDS = ['project', 'dashboard', 'definition'] as const;
export type ProductSearchKind = (typeof PRODUCT_SEARCH_KINDS)[number];

export interface ProductSearchHit {
  readonly kind: ProductSearchKind;
  readonly id: string;
  readonly title: string;
  /** Where it lives, for telling two things with the same name apart. */
  readonly context: string;
  /** A product route. Never an external address. */
  readonly href: string;
}

export interface ProductSearchResult {
  readonly query: string;
  readonly hits: readonly ProductSearchHit[];
}
