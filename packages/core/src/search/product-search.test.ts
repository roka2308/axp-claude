import { describe, expect, it } from 'vitest';
import { normaliseSearchText, searchProducts, type SearchCandidate } from './product-search';

const candidate = (title: string, keywords?: string): SearchCandidate => ({
  kind: 'dashboard',
  id: title,
  title,
  context: 'Employee Portal',
  href: `/dashboards/${title}`,
  ...(keywords ? { keywords } : {}),
});

describe('product search', () => {
  it('folds case, accents and ß, so German is searchable without umlauts', () => {
    expect(normaliseSearchText('Übersicht Straße')).toBe('ubersicht strasse');
    expect(searchProducts([candidate('Portal-Übersicht')], 'ubersicht')).toHaveLength(1);
  });

  it('requires every term, because a query narrows', () => {
    const all = [candidate('Portal Overview'), candidate('Portal Suche'), candidate('Overview')];
    expect(searchProducts(all, 'portal overview').map((hit) => hit.title)).toEqual([
      'Portal Overview',
    ]);
  });

  it('ranks a title that starts with the query above one that merely contains it', () => {
    const hits = searchProducts(
      [candidate('Mitarbeiter Besuche'), candidate('Besuche'), candidate('Besuche je Seite')],
      'besuche',
    );
    expect(hits.map((hit) => hit.title)).toEqual([
      'Besuche',
      'Besuche je Seite',
      'Mitarbeiter Besuche',
    ]);
  });

  it('finds by keywords but never returns them', () => {
    const hits = searchProducts(
      [candidate('Besuche', 'zusammenhängende Folge von Aufrufen')],
      'aufrufen',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).not.toHaveProperty('keywords');
  });

  it('returns nothing for an empty query rather than everything', () => {
    expect(searchProducts([candidate('Portal')], '   ')).toEqual([]);
  });

  it('caps the result, since a search box is not a listing', () => {
    const many = Array.from({ length: 50 }, (_, index) => candidate(`Dashboard ${index}`));
    expect(searchProducts(many, 'dashboard')).toHaveLength(20);
  });
});
