import type { ProductSearchHit } from '@axp/contracts';

/**
 * Product search (D1: "Produktsuche" in the top bar).
 *
 * Finds product objects - projects, dashboards, metric definitions - by name.
 * Never analytics: nothing here reads Matomo, and nothing it returns is a
 * measurement. D1 is explicit that Search/Interests is not a module, and a
 * search box that answered "how many visits" would be one through the back
 * door.
 *
 * The candidates arrive already filtered to what the caller may see. This
 * function only matches and ranks, which keeps it pure and keeps the
 * authorization decision in exactly one place: the route that assembled them.
 */

export interface SearchCandidate extends ProductSearchHit {
  /** Extra text that may match, such as a glossary description. */
  readonly keywords?: string;
}

/** The most a single search returns. A search box is not a listing. */
export const SEARCH_RESULT_LIMIT = 20;

/**
 * Folds case and accents, so "Uber" finds "Über" and "ubersicht" finds
 * "Übersicht" - the difference between a search that works for German and one
 * that only works for people who type umlauts.
 */
export function normaliseSearchText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .trim();
}

/**
 * Matches every term of the query against a candidate and ranks the hits.
 *
 * All terms must match (AND), because a query is a narrowing: "portal besuche"
 * means both. Ranking, best first:
 *
 *   1. the title starts with the query
 *   2. a word in the title starts with a term
 *   3. the title contains every term
 *   4. only the keywords do
 *
 * Ties break on the title, so the order is stable between two identical
 * searches - which people notice, and tests depend on.
 */
export function searchProducts(
  candidates: readonly SearchCandidate[],
  query: string,
  limit = SEARCH_RESULT_LIMIT,
): ProductSearchHit[] {
  const normalisedQuery = normaliseSearchText(query);
  const terms = normalisedQuery.split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return [];

  const scored: { hit: ProductSearchHit; score: number }[] = [];

  for (const candidate of candidates) {
    const title = normaliseSearchText(candidate.title);
    const keywords = normaliseSearchText(candidate.keywords ?? '');
    const everything = `${title} ${keywords}`;

    if (!terms.every((term) => everything.includes(term))) continue;

    const words = title.split(/[\s\-_/·.,]+/);
    const score = title.startsWith(normalisedQuery)
      ? 0
      : terms.every((term) => words.some((word) => word.startsWith(term)))
        ? 1
        : terms.every((term) => title.includes(term))
          ? 2
          : 3;

    // The keywords are for matching only; they never leave the server.
    const { keywords: _keywords, ...hit } = candidate;
    scored.push({ hit, score });
  }

  return scored
    .sort((a, b) => a.score - b.score || a.hit.title.localeCompare(b.hit.title, 'de'))
    .slice(0, limit)
    .map((entry) => entry.hit);
}
