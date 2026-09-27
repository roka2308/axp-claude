import { useId } from 'react';
import { useTranslations } from 'next-intl';
import type { DataAccessView, EffectiveAccess } from '@axp/contracts';
import { Callout } from '@axp/ui';
import { AccessChain } from './AccessChain';
import styles from './EffectiveAccessPanel.module.css';

/**
 * "What can this user do, where, and why?" (Gate F5)
 *
 * Two answers, kept apart because they are two different things:
 *
 *   1. what the person may *do*, per scope - capabilities from roles;
 *   2. which *data* they may see or change - which needs a role and a grant.
 *
 * Every "yes" names its reasons; every "no" on a dashboard names the missing
 * half. Nothing here needs a database row to be understood.
 */
export function EffectiveAccessPanel({
  access,
  subjectName,
}: {
  readonly access: EffectiveAccess;
  readonly subjectName: string;
}) {
  const t = useTranslations('administration.effective');
  const tCap = useTranslations('capability');
  // Several panels can share a page (one per tenant on the profile page).
  const id = useId();
  const doId = `${id}-do`;
  const dataId = `${id}-data`;

  if (!access.active) {
    return (
      <Callout tone="warning" title={t('inactiveTitle')}>
        {t('inactiveBody', { name: subjectName })}
      </Callout>
    );
  }

  return (
    <div className="stack stack--loose">
      <section className="stack" aria-labelledby={doId}>
        <h3 id={doId} className={styles.heading}>
          {t('doTitle', { name: subjectName })}
        </h3>
        {access.scopes.length === 0 ? (
          <p className="text-muted">{t('doNothing')}</p>
        ) : (
          <div className={styles.scroller}>
            <table className={styles.table} aria-labelledby={doId}>
              <thead>
                <tr>
                  <th scope="col">{t('columnScope')}</th>
                  <th scope="col">{t('columnCapabilities')}</th>
                  <th scope="col">{t('columnWhy')}</th>
                </tr>
              </thead>
              <tbody>
                {access.scopes.map((scope) => {
                  // The same reason usually explains several capabilities: show
                  // each distinct chain once.
                  const reasons = [
                    ...new Map(
                      scope.capabilities
                        .flatMap((entry) => entry.reasons)
                        .map((reason) => [JSON.stringify(reason.chain), reason]),
                    ).values(),
                  ];
                  return (
                    <tr key={`${scope.scope.type}:${scope.scope.id}`}>
                      <th scope="row">
                        {t(`scope.${scope.scope.type}`, { name: scope.scope.label })}
                      </th>
                      <td>
                        <ul className={styles.capabilities}>
                          {scope.capabilities.map((entry) => (
                            <li key={entry.capability}>{tCap(entry.capability)}</li>
                          ))}
                        </ul>
                      </td>
                      <td>
                        {reasons.map((reason, index) => (
                          <AccessChain key={index} reason={reason} />
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="stack" aria-labelledby={dataId}>
        <h3 id={dataId} className={styles.heading}>
          {t('dataTitle', { name: subjectName })}
        </h3>
        <Callout tone="info">{t('principle')}</Callout>
        {access.dashboards.length === 0 ? (
          <p className="text-muted">{t('noDashboards')}</p>
        ) : (
          <div className={styles.scroller}>
            <table className={styles.table} aria-labelledby={dataId}>
              <thead>
                <tr>
                  <th scope="col">{t('columnDashboard')}</th>
                  <th scope="col">{t('columnView')}</th>
                  <th scope="col">{t('columnEdit')}</th>
                  <th scope="col">{t('columnWhy')}</th>
                </tr>
              </thead>
              <tbody>
                {access.dashboards.map((dashboard) => (
                  <tr key={dashboard.id}>
                    <th scope="row">
                      {dashboard.name}
                      <span className={styles.context}>{dashboard.projectName}</span>
                    </th>
                    <td>
                      <Verdict view={dashboard.view} />
                    </td>
                    <td>
                      <Verdict view={dashboard.edit} />
                    </td>
                    <td>
                      <Why view={dashboard.edit.granted ? dashboard.edit : dashboard.view} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** Yes or no, in words - and for a no, which half is missing (D10: no colour-only). */
function Verdict({ view }: { readonly view: DataAccessView }) {
  const t = useTranslations('administration.effective');
  return (
    <span className={styles.verdict} data-granted={view.granted}>
      <span aria-hidden="true">{view.granted ? '✓' : '–'}</span>{' '}
      {view.granted ? t('yes') : t(`missing.${view.missing ?? 'role_and_grant'}`)}
    </span>
  );
}

function Why({ view }: { readonly view: DataAccessView }) {
  const t = useTranslations('administration.effective');
  const reasons = [...view.roleReasons, ...view.grantReasons];
  if (reasons.length === 0) return <span className="text-muted">{t('noReason')}</span>;

  return (
    <details className={styles.why}>
      <summary>{t('showReasons', { count: reasons.length })}</summary>
      <div className="stack stack--tight">
        {view.roleReasons.map((reason, index) => (
          <AccessChain key={`r${index}`} reason={reason} />
        ))}
        {view.grantReasons.map((reason, index) => (
          <AccessChain key={`g${index}`} reason={reason} />
        ))}
      </div>
    </details>
  );
}
