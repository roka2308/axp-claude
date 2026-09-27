import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { ProductErrorCategory } from '@axp/contracts';
import { ApiError, ApiUnreachableError } from '@/lib/api-client';
import { resolveError } from '@/lib/error-messages';
import styles from './CauseSurface.module.css';

/**
 * Why a whole dashboard cannot be shown, as one of the distinct surfaces D10
 * requires.
 *
 * Permission, entitlement, capability, setup and temporary unavailability are
 * five situations with five different next steps - ask someone for access, ask
 * for a contract change, accept a limitation of this Matomo, finish the setup,
 * or wait. Collapsing them into one "something went wrong" page is exactly
 * what the state model exists to prevent, so each gets its own heading, its
 * own explanation of what it means, and its own suggestion.
 *
 * Every surface answers the three questions of Master Spec §17: what
 * happened, what it means, what can be done. The correlation id is there, but
 * behind a disclosure.
 */

type Surface =
  | 'permission'
  | 'entitlement'
  | 'capability'
  | 'setup'
  | 'unavailable'
  | 'not_found'
  | 'unexpected';

export async function CauseSurface({ error }: { readonly error: unknown }) {
  const t = await getTranslations();
  const resolved = await resolveError(error);
  const surface = surfaceFor(error);

  return (
    <section
      className={styles.surface}
      data-surface={surface}
      aria-labelledby="cause-surface-title"
    >
      {/* A word, not an icon colour, says which kind of problem this is. */}
      <p className={styles.kind}>{t(`cause.${surface}.kind`)}</p>
      <h1 id="cause-surface-title" className={styles.title}>
        {t(`cause.${surface}.title`)}
      </h1>

      <dl className={styles.questions}>
        <dt>{t('cause.whatHappened')}</dt>
        <dd>{resolved.message}</dd>
        <dt>{t('cause.whatItMeans')}</dt>
        <dd>{t(`cause.${surface}.meaning`)}</dd>
        <dt>{t('cause.whatYouCanDo')}</dt>
        <dd>{resolved.action ?? t(`cause.${surface}.action`)}</dd>
      </dl>

      {resolved.correlationId ? (
        <details className={styles.technical}>
          <summary>{t('errors.technicalDetails')}</summary>
          <p>
            {t('errors.correlationId')}: <code>{resolved.correlationId}</code>
          </p>
        </details>
      ) : null}

      <Link href="/projects">{t('projects.backToList')}</Link>
    </section>
  );
}

function surfaceFor(error: unknown): Surface {
  if (error instanceof ApiUnreachableError) return 'unavailable';
  if (!(error instanceof ApiError)) return 'unexpected';

  const byCategory: Partial<Record<ProductErrorCategory, Surface>> = {
    permission_denied: 'permission',
    authentication_required: 'permission',
    entitlement_required: 'entitlement',
    capability_unsupported: 'capability',
    setup_required: 'setup',
    invalid_configuration: 'setup',
    source_unavailable: 'unavailable',
    rate_limited: 'unavailable',
    not_found: 'not_found',
  };

  return byCategory[error.body.category] ?? 'unexpected';
}
