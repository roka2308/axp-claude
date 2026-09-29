'use client';

import { useTranslations } from 'next-intl';
import {
  applyPlacement,
  type Breakpoint,
  CARD_VARIANTS,
  clearOverride,
  type DashboardSnapshot,
  GRID_COLUMNS,
  hasOverride,
  resolveLayout,
  type WidgetConfig,
  WIDGET_SIZE_RULES,
} from '@axp/contracts';
import { Button, SelectField, TextField } from '@axp/ui';
import styles from './Inspector.module.css';

export interface InspectorProps {
  readonly snapshot: DashboardSnapshot;
  readonly breakpoint: Breakpoint;
  readonly selectedId: string | null;
  readonly onChange: (snapshot: DashboardSnapshot) => void;
  readonly onRemove: (widgetId: string) => void;
}

/**
 * The right contextual Inspector (D3).
 *
 * Contextual means it follows the selection rather than offering everything at
 * once: a widget shows Data, Presentation, Context and Layout; nothing selected
 * shows Dashboard Settings. There is no separate settings screen to get lost
 * in, and no panel full of controls that do not apply.
 *
 * Layout is expressed as numbers here as well as by dragging, because precise
 * placement with a pointer is a game of skill and nobody should have to win it.
 */
export function Inspector({
  snapshot,
  breakpoint,
  selectedId,
  onChange,
  onRemove,
}: InspectorProps) {
  const t = useTranslations('editor');
  const widget = snapshot.widgets.find((candidate) => candidate.id === selectedId) ?? null;

  if (!widget) {
    return (
      <aside className={styles.inspector} aria-label={t('dashboardSettings')}>
        <h2 className={styles.heading}>{t('dashboardSettings')}</h2>
        <p className={styles.hint}>{t('selectHint')}</p>

        <TextField
          label={t('dashboardName')}
          value={snapshot.name}
          onChange={(event) => onChange({ ...snapshot, name: event.target.value })}
          required
        />

        <TextField
          label={t('dashboardDescription')}
          value={snapshot.description ?? ''}
          hint={t('dashboardDescriptionHint')}
          onChange={(event) => onChange({ ...snapshot, description: event.target.value })}
        />

        <TextField
          label={t('internalNote')}
          value={snapshot.internalNote ?? ''}
          hint={t('internalNoteHint')}
          maxLength={2000}
          onChange={(event) =>
            onChange({ ...snapshot, internalNote: event.target.value || undefined })
          }
        />
      </aside>
    );
  }

  const placement = resolveLayout(snapshot.widgets, breakpoint).get(widget.id)!;
  const rules = WIDGET_SIZE_RULES[widget.family];
  const columns = GRID_COLUMNS[breakpoint];

  const update = (changed: Partial<WidgetConfig>) =>
    onChange({
      ...snapshot,
      widgets: snapshot.widgets.map((candidate) =>
        candidate.id === widget.id ? { ...candidate, ...changed } : candidate,
      ),
    });

  const place = (next: Partial<typeof placement>) => {
    const { widgets } = applyPlacement(
      snapshot.widgets,
      widget.id,
      { ...placement, ...next },
      breakpoint,
    );
    onChange({ ...snapshot, widgets });
  };

  return (
    <aside className={styles.inspector} aria-label={t('widgetSettings', { title: widget.title })}>
      <h2 className={styles.heading}>{widget.title}</h2>
      <p className={styles.hint}>{t(`family.${widget.family}`)}</p>

      <section className={styles.section} aria-label={t('sectionContent')}>
        <h3 className={styles.sectionHeading}>{t('sectionContent')}</h3>

        <TextField
          label={t('widgetTitle')}
          value={widget.title}
          onChange={(event) => update({ title: event.target.value })}
          required
        />

        <TextField
          label={t('widgetDescription')}
          value={widget.context.description ?? ''}
          hint={t('widgetDescriptionHint')}
          onChange={(event) =>
            update({ context: { ...widget.context, description: event.target.value } })
          }
        />

        <TextField
          label={t('internalNote')}
          value={widget.context.internalNote ?? ''}
          hint={t('internalNoteHint')}
          maxLength={2000}
          onChange={(event) =>
            update({
              context: { ...widget.context, internalNote: event.target.value || undefined },
            })
          }
        />
      </section>

      <section className={styles.section} aria-label={t('sectionPresentation')}>
        <h3 className={styles.sectionHeading}>{t('sectionPresentation')}</h3>

        {widget.family === 'card' ? (
          <SelectField
            label={t('cardVariant')}
            value={widget.presentation.variant ?? 'kpi'}
            options={CARD_VARIANTS.map((variant) => ({
              value: variant,
              label: t(`cardVariantName.${variant}`),
            }))}
            onChange={(event) =>
              update({ presentation: { ...widget.presentation, variant: event.target.value } })
            }
          />
        ) : null}

        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={widget.presentation.showComparison}
            onChange={(event) =>
              update({
                presentation: { ...widget.presentation, showComparison: event.target.checked },
              })
            }
          />
          {t('showComparison')}
        </label>

        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={widget.context.showDefinition}
            onChange={(event) =>
              update({ context: { ...widget.context, showDefinition: event.target.checked } })
            }
          />
          {t('showDefinition')}
        </label>
      </section>

      {/*
        The same move and resize the canvas offers, as numbers. Precise
        placement with a pointer is a game of skill (D2, D10).
      */}
      <section className={styles.section} aria-label={t('sectionLayout')}>
        <h3 className={styles.sectionHeading}>{t('sectionLayout')}</h3>

        <div className={styles.grid2}>
          <NumberField
            label={t('positionX')}
            value={placement.x}
            min={0}
            max={columns - placement.w}
            onCommit={(x) => place({ x })}
          />
          <NumberField
            label={t('positionY')}
            value={placement.y}
            min={0}
            max={200}
            onCommit={(y) => place({ y })}
          />
          <NumberField
            label={t('sizeW')}
            value={placement.w}
            min={Math.min(rules.minW, columns)}
            max={columns}
            onCommit={(w) => place({ w })}
          />
          <NumberField
            label={t('sizeH')}
            value={placement.h}
            min={rules.minH}
            max={24}
            onCommit={(h) => place({ h })}
          />
        </div>

        <p className={styles.hint}>{t('minSize', { minW: rules.minW, minH: rules.minH })}</p>

        {breakpoint === 'desktop' ? (
          <p className={styles.hint}>{t('desktopIsAuthored')}</p>
        ) : hasOverride(widget, breakpoint) ? (
          <div className="stack stack--tight">
            <p className={styles.hint}>{t('overrideActive', { breakpoint: t(breakpoint) })}</p>
            <Button
              type="button"
              onClick={() =>
                onChange({
                  ...snapshot,
                  widgets: snapshot.widgets.map((candidate) =>
                    candidate.id === widget.id ? clearOverride(candidate, breakpoint) : candidate,
                  ),
                })
              }
            >
              {t('resetOverride')}
            </Button>
          </div>
        ) : (
          <p className={styles.hint}>{t('derivedLayout', { breakpoint: t(breakpoint) })}</p>
        )}
      </section>

      <section className={styles.section} aria-label={t('sectionDanger')}>
        <Button type="button" variant="danger" onClick={() => onRemove(widget.id)}>
          {t('removeWidget')}
        </Button>
      </section>
    </aside>
  );
}

/**
 * A number input that only commits a usable value.
 *
 * Typing "1" on the way to "12" must not move the widget to column 1 and fight
 * the keystrokes; the change lands on blur or Enter.
 */
function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onCommit: (value: number) => void;
}) {
  return (
    <TextField
      label={label}
      type="number"
      inputMode="numeric"
      defaultValue={String(value)}
      key={`${label}-${value}`}
      min={min}
      max={max}
      onBlur={(event) => {
        const parsed = Number(event.target.value);
        if (Number.isFinite(parsed)) onCommit(parsed);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const parsed = Number((event.target as HTMLInputElement).value);
        if (Number.isFinite(parsed)) onCommit(parsed);
      }}
    />
  );
}
