'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import type { BindingHealth, SourceBindingDescriptor, SourceBindingRef } from '@axp/contracts';
import { Button, Callout, Card, SelectField, TextField } from '@axp/ui';
import { setBindingAction } from '@/app/projects/[projectId]/semantics/actions';
import styles from './SourceMappings.module.css';

export interface SourceMappingsProps {
  readonly projectId: string;
  readonly bindings: readonly SourceBindingRef[];
  readonly health: readonly BindingHealth[];
  /** What the site currently offers, so a mapping is made from real names. */
  readonly available: {
    readonly metrics: readonly string[];
    readonly dimensions: readonly string[];
  };
  readonly canManage: boolean;
}

/**
 * Source mapping (Master Spec §13, D6).
 *
 * Says what the product needs in words - "engaged users" - and lets someone
 * point it at what this Matomo actually has. Deliberately not a field list:
 * the question is a business one, and the technical answer is the part being
 * chosen.
 *
 * Correcting a mapping here never creates a semantic version. The definition
 * of "engaged users" did not change because somebody fixed the wiring
 * (Gate F3).
 */
export function SourceMappings({
  projectId,
  bindings,
  health,
  available,
  canManage,
}: SourceMappingsProps) {
  const t = useTranslations('semantics');
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const [requirementKey, setRequirementKey] = useState('');
  const [kind, setKind] = useState<SourceBindingDescriptor['kind']>('custom_dimension');
  const [target, setTarget] = useState('');

  const healthOf = new Map(health.map((entry) => [entry.requirementKey, entry]));

  function save() {
    const binding = describeBinding(kind, target);
    if (!requirementKey || !binding) return;

    setMessage(null);
    startTransition(async () => {
      const result = await setBindingAction(projectId, requirementKey, binding);
      setMessage(result.status === 'saved' ? t('mappingSaved') : (result.message ?? null));
      if (result.status === 'saved') setRequirementKey('');
    });
  }

  return (
    <Card title={t('mappingsTitle')} description={t('mappingsBody')}>
      <div className="stack">
        {message ? (
          <Callout tone="info" live>
            {message}
          </Callout>
        ) : null}

        {bindings.length === 0 ? (
          <p className="text-muted">{t('noMappings')}</p>
        ) : (
          <ul className={styles.list}>
            {bindings.map((binding) => {
              const state = healthOf.get(binding.requirementKey)?.state ?? 'ok';
              return (
                <li key={binding.id} className={styles.row} data-state={state}>
                  <span className={styles.requirement}>{binding.requirementKey}</span>
                  <span className={styles.binding}>{describe(binding.binding, t)}</span>
                  {/*
                    Drift is a word and a state, never a coloured dot: "needs
                    review" and "not available here" are different situations
                    (D10).
                  */}
                  <span className={styles.state}>{t(`drift.${state}`)}</span>
                </li>
              );
            })}
          </ul>
        )}

        {available.dimensions.length > 0 ? (
          <details className={styles.sample}>
            <summary className={styles.summary}>{t('availableTitle')}</summary>
            <p className={styles.hint}>{t('availableBody')}</p>
            <ul className={styles.chips}>
              {available.dimensions.slice(0, 20).map((dimension) => (
                <li key={dimension} className={styles.chip}>
                  {dimension}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {canManage ? (
          <div className="stack">
            <h4 className={styles.heading}>{t('newMapping')}</h4>

            <TextField
              label={t('requirementKey')}
              hint={t('requirementKeyHint')}
              value={requirementKey}
              onChange={(event) => setRequirementKey(event.target.value)}
              placeholder="pulse.engaged_users"
            />

            <SelectField
              label={t('bindingKind')}
              value={kind}
              options={[
                { value: 'custom_dimension', label: t('bindingKindName.custom_dimension') },
                { value: 'event', label: t('bindingKindName.event') },
                { value: 'goal', label: t('bindingKindName.goal') },
                { value: 'site_search', label: t('bindingKindName.site_search') },
                { value: 'native_metric', label: t('bindingKindName.native_metric') },
                { value: 'not_available', label: t('bindingKindName.not_available') },
              ]}
              onChange={(event) => {
                setKind(event.target.value as SourceBindingDescriptor['kind']);
                setTarget('');
              }}
            />

            {kind === 'site_search' || kind === 'not_available' ? null : (
              <TextField
                label={t(`bindingTarget.${kind}`)}
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              />
            )}

            <div className="row">
              <Button
                type="button"
                variant="primary"
                onClick={save}
                disabled={!requirementKey || pending}
                busy={pending}
                busyLabel={t('saving')}
              >
                {t('saveMapping')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

type Translator = ReturnType<typeof useTranslations>;

function describe(binding: SourceBindingDescriptor, t: Translator): string {
  switch (binding.kind) {
    case 'native_metric':
      return t('bindingDescription.native_metric', { metric: binding.sourceMetric });
    case 'event':
      return t('bindingDescription.event', {
        category: binding.category,
        action: binding.action ?? '*',
      });
    case 'custom_dimension':
      return t('bindingDescription.custom_dimension', { index: binding.index });
    case 'goal':
      return t('bindingDescription.goal', { goalId: binding.goalId });
    case 'site_search':
      return t('bindingDescription.site_search');
    case 'not_available':
      return t('bindingDescription.not_available');
  }
}

/** Turns the form's two fields into a descriptor, or nothing if incomplete. */
function describeBinding(
  kind: SourceBindingDescriptor['kind'],
  target: string,
): SourceBindingDescriptor | null {
  switch (kind) {
    case 'site_search':
      return { kind: 'site_search' };
    case 'not_available':
      return { kind: 'not_available' };
    case 'native_metric':
      return target ? { kind: 'native_metric', sourceMetric: target } : null;
    case 'event':
      return target ? { kind: 'event', category: target } : null;
    case 'custom_dimension': {
      const index = Number(target);
      return Number.isInteger(index) && index > 0 ? { kind: 'custom_dimension', index } : null;
    }
    case 'goal': {
      const goalId = Number(target);
      return Number.isInteger(goalId) && goalId > 0 ? { kind: 'goal', goalId } : null;
    }
  }
}
