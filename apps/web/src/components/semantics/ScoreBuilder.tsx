'use client';

import { useTranslations } from 'next-intl';
import type { ScoreComponent, ScoreDefinition, SemanticDefinitionRef } from '@axp/contracts';
import { Button, Callout, SelectField, TextField } from '@axp/ui';
import styles from './ScoreBuilder.module.css';

export interface ScoreBuilderProps {
  readonly definition: ScoreDefinition;
  readonly onChange: (definition: ScoreDefinition) => void;
  readonly metrics: readonly SemanticDefinitionRef[];
}

/**
 * Score builder (Master Spec §14, D6).
 *
 * Two things this screen has to make unmistakable:
 *
 *   - **every component is required.** The panel says so, because the first
 *     question anyone asks is "what if one of these is missing", and the
 *     answer - the score is not calculable - is a design decision rather than
 *     a limitation (Gate F3);
 *   - **what counts as good is declared**, per component, as a line between a
 *     worst and a best value. Putting the worse number in `worst` is how
 *     "lower is better" is expressed, with no separate switch.
 */
export function ScoreBuilder({ definition, onChange, metrics }: ScoreBuilderProps) {
  const t = useTranslations('semantics');
  const usable = metrics.filter((metric) => metric.currentVersionId);

  const totalWeight = definition.components.reduce((sum, component) => sum + component.weight, 0);

  function updateComponent(index: number, changed: Partial<ScoreComponent>) {
    onChange({
      ...definition,
      components: definition.components.map((component, position) =>
        position === index ? { ...component, ...changed } : component,
      ),
    });
  }

  return (
    <div className="stack">
      <Callout tone="info" title={t('allComponentsRequiredTitle')}>
        {t('allComponentsRequiredBody')}
      </Callout>

      <section className="stack" aria-label={t('components')}>
        <h4 className={styles.heading}>{t('components')}</h4>

        {definition.components.map((component, index) => {
          const share = totalWeight > 0 ? Math.round((component.weight / totalWeight) * 100) : 0;
          const linear = component.normalisation.kind === 'linear' ? component.normalisation : null;

          return (
            <fieldset key={index} className={styles.component}>
              <legend className={styles.legend}>
                {t('componentNumber', { index: index + 1, share })}
              </legend>

              <div className={styles.row}>
                <SelectField
                  label={t('metric')}
                  value={component.semanticVersionId}
                  options={usable.map((metric) => ({
                    value: metric.currentVersionId!,
                    label: metric.name,
                  }))}
                  onChange={(event) =>
                    updateComponent(index, { semanticVersionId: event.target.value })
                  }
                />

                <TextField
                  label={t('weight')}
                  type="number"
                  min={1}
                  defaultValue={String(component.weight)}
                  key={`weight-${index}-${component.weight}`}
                  hint={t('weightHint', { share })}
                  onBlur={(event) => {
                    const parsed = Number(event.target.value);
                    if (Number.isFinite(parsed) && parsed > 0) {
                      updateComponent(index, { weight: parsed });
                    }
                  }}
                />
              </div>

              <SelectField
                label={t('normalisation')}
                value={component.normalisation.kind}
                options={[
                  { value: 'linear', label: t('normalisationLinear') },
                  { value: 'bands', label: t('normalisationBands') },
                ]}
                onChange={(event) =>
                  updateComponent(index, {
                    normalisation:
                      event.target.value === 'linear'
                        ? { kind: 'linear', worst: 0, best: 100 }
                        : { kind: 'bands', bands: [{ atLeast: 0, points: 0 }] },
                  })
                }
              />

              {linear ? (
                <div className={styles.row}>
                  <TextField
                    label={t('worst')}
                    type="number"
                    step="any"
                    defaultValue={String(linear.worst)}
                    hint={t('worstHint')}
                    onBlur={(event) =>
                      updateComponent(index, {
                        normalisation: { ...linear, worst: Number(event.target.value) },
                      })
                    }
                  />
                  <TextField
                    label={t('best')}
                    type="number"
                    step="any"
                    defaultValue={String(linear.best)}
                    hint={t('bestHint')}
                    onBlur={(event) =>
                      updateComponent(index, {
                        normalisation: { ...linear, best: Number(event.target.value) },
                      })
                    }
                  />
                </div>
              ) : (
                <p className={styles.hint}>{t('bandsHint')}</p>
              )}

              {definition.components.length > 1 ? (
                <Button
                  type="button"
                  variant="danger"
                  onClick={() =>
                    onChange({
                      ...definition,
                      components: definition.components.filter(
                        (_component, position) => position !== index,
                      ),
                    })
                  }
                >
                  {t('removeComponent')}
                </Button>
              ) : null}
            </fieldset>
          );
        })}

        {definition.components.length < 12 && usable.length > 0 ? (
          <div>
            <Button
              type="button"
              onClick={() =>
                onChange({
                  ...definition,
                  components: [
                    ...definition.components,
                    {
                      semanticVersionId: usable[0]!.currentVersionId!,
                      weight: 10,
                      normalisation: { kind: 'linear', worst: 0, best: 100 },
                    },
                  ],
                })
              }
            >
              {t('addComponent')}
            </Button>
          </div>
        ) : null}
      </section>

      {/*
        Bands turn a number into a judgement. Optional on purpose: a score
        without them is a number, and the product does not invent a verdict.
      */}
      <section className="stack" aria-label={t('evaluation')}>
        <h4 className={styles.heading}>{t('evaluation')}</h4>
        <p className={styles.hint}>{t('evaluationHint')}</p>

        {definition.evaluation.map((band, index) => (
          <div key={index} className={styles.row}>
            <TextField
              label={t('bandKey')}
              defaultValue={band.key}
              onBlur={(event) =>
                onChange({
                  ...definition,
                  evaluation: definition.evaluation.map((current, position) =>
                    position === index ? { ...current, key: event.target.value } : current,
                  ),
                })
              }
            />
            <TextField
              label={t('bandAtLeast')}
              type="number"
              min={0}
              max={100}
              defaultValue={String(band.atLeast)}
              onBlur={(event) =>
                onChange({
                  ...definition,
                  evaluation: definition.evaluation.map((current, position) =>
                    position === index
                      ? { ...current, atLeast: Number(event.target.value) }
                      : current,
                  ),
                })
              }
            />
            <Button
              type="button"
              onClick={() =>
                onChange({
                  ...definition,
                  evaluation: definition.evaluation.filter((_band, position) => position !== index),
                })
              }
            >
              {t('removeBand')}
            </Button>
          </div>
        ))}

        {definition.evaluation.length < 5 ? (
          <div>
            <Button
              type="button"
              onClick={() =>
                onChange({
                  ...definition,
                  evaluation: [
                    ...definition.evaluation,
                    {
                      key: 'band',
                      atLeast: Math.min(100, definition.evaluation.length * 25),
                      band: Math.min(5, definition.evaluation.length + 1) as 1 | 2 | 3 | 4 | 5,
                    },
                  ],
                })
              }
            >
              {t('addBand')}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/** A score that already means something, rather than an empty shell. */
export function blankScore(metricVersionId: string): ScoreDefinition {
  return {
    kind: 'score',
    unit: 'score',
    scope: 'visit',
    direction: 'higher_is_better',
    decimals: 1,
    components: [
      {
        semanticVersionId: metricVersionId,
        weight: 100,
        normalisation: { kind: 'linear', worst: 0, best: 100 },
      },
    ],
    evaluation: [
      { key: 'weak', atLeast: 0, band: 1 },
      { key: 'fair', atLeast: 50, band: 3 },
      { key: 'good', atLeast: 75, band: 4 },
    ],
  };
}
