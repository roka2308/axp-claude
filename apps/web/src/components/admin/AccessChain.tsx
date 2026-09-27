import { useTranslations } from 'next-intl';
import type { AccessReason } from '@axp/contracts';
import styles from './AccessChain.module.css';

/**
 * One reason for access, as a readable chain (Master Spec §7).
 *
 * "Effective Access zeigt immer was und warum, zum Beispiel via Gruppe → Rolle
 * → Scope." Each link is a list item, so a screen reader announces the chain
 * as the sequence it is; the arrows are decoration and hidden from it.
 */
export function AccessChain({ reason }: { readonly reason: AccessReason }) {
  const t = useTranslations('administration.chain');
  const tRoles = useTranslations('roles');
  // The server names the reason by its full key (`access.reason.*`).
  const tRoot = useTranslations();

  return (
    <div className={styles.reason}>
      <span className={styles.summary}>{tRoot(reason.summaryKey)}</span>
      <ol className={styles.chain}>
        {reason.chain.map((link, index) => (
          <li key={index} className={styles.link} data-kind={link.kind}>
            {index > 0 ? (
              <span className={styles.arrow} aria-hidden="true">
                →
              </span>
            ) : null}
            {link.kind === 'user' ? <span>{link.label}</span> : null}
            {link.kind === 'group' ? <span>{t('group', { name: link.label })}</span> : null}
            {link.kind === 'role_assignment' ? (
              <span>{t('role', { role: tRoles(`${link.role}.label`) })}</span>
            ) : null}
            {link.kind === 'scope' ? (
              <span>{t(`scope.${link.scope.type}`, { name: link.label })}</span>
            ) : null}
            {link.kind === 'object_grant' ? (
              <span>
                {t(`grant.${link.objectType}`, {
                  name: link.label ?? link.objectId,
                  access: t(`access.${link.access}`),
                })}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
