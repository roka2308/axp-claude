'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { useTranslations } from 'next-intl';
import {
  REPORT_COMPARISONS,
  REPORT_FREQUENCIES,
  REPORT_PERIODS,
  type ReportDeliveryMode,
  type ReportFormat,
  type ReportFrequency,
  type ReportRecipient,
  type ReportScheduleInput,
  type ReportScheduleOptions,
  type ReportScheduleSummary,
} from '@axp/contracts';
import { Button, Callout, SelectField, TextField } from '@axp/ui';
import { recipientsAction, saveReportAction } from '@/app/reporting/actions';
import styles from './reporting.module.css';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export interface ReportScheduleFormProps {
  readonly projectId: string;
  readonly options: ReportScheduleOptions;
  /** Set when editing an existing schedule. */
  readonly initial?: ReportScheduleSummary;
}

/**
 * Plans a report (Master Spec §15): which published dashboard, which relative
 * period, how often, in which time zone, to whom, as a file or a link.
 *
 * Recipients are offered from the dashboard's actual audience: people who
 * may not open the dashboard are listed, but cannot be ticked, and say why.
 */
export function ReportScheduleForm({ projectId, options, initial }: ReportScheduleFormProps) {
  const t = useTranslations('reports');
  const router = useRouter();
  const [dashboardId, setDashboardId] = useState(
    initial?.dashboardId ?? options.dashboards[0]?.id ?? '',
  );
  const [name, setName] = useState(initial?.name ?? '');
  const [format, setFormat] = useState<ReportFormat>(initial?.format ?? 'pdf');
  const [period, setPeriod] = useState<ReportScheduleInput['period']>(
    initial?.period ?? 'last_7_days',
  );
  const [comparison, setComparison] = useState<ReportScheduleInput['comparison']>(
    initial?.comparison ?? 'previous_period',
  );
  const [frequency, setFrequency] = useState<ReportFrequency>(
    initial?.rhythm.frequency ?? 'weekly',
  );
  const [time, setTime] = useState(initial?.rhythm.time ?? '07:00');
  const [weekday, setWeekday] = useState(initial?.rhythm.weekday ?? 1);
  const [dayOfMonth, setDayOfMonth] = useState<number | 'last'>(initial?.rhythm.dayOfMonth ?? 1);
  const [weekdays, setWeekdays] = useState<number[]>(initial?.rhythm.weekdays ?? [1, 3, 5]);
  const [timezone, setTimezone] = useState(initial?.timezone ?? options.timezone);
  const [deliveryMode, setDeliveryMode] = useState<ReportDeliveryMode>(
    initial?.deliveryMode ?? 'attachment',
  );
  const [recipients, setRecipients] = useState<ReportRecipient[]>([]);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initial?.recipients.map((recipient) => recipient.userId) ?? []),
  );
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!dashboardId) return;
    let cancelled = false;
    void recipientsAction(projectId, dashboardId).then((outcome) => {
      if (cancelled || outcome.status !== 'ok' || !outcome.data) return;
      setRecipients(outcome.data);
      // Nobody stays ticked who may not see the newly chosen dashboard.
      setSelected((current) => {
        const allowed = new Set(
          outcome.data!.filter((entry) => entry.hasAccess).map((entry) => entry.userId),
        );
        return new Set([...current].filter((userId) => allowed.has(userId)));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, dashboardId]);

  if (options.dashboards.length === 0) {
    return (
      <Callout tone="info" title={t('form.noDashboardsTitle')}>
        {t('form.noDashboardsBody')}
      </Callout>
    );
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      setError(null);
      setFieldErrors({});
      const rhythm: ReportScheduleInput['rhythm'] = {
        frequency,
        time,
        ...(frequency === 'weekly' ? { weekday } : {}),
        ...(frequency === 'monthly' || frequency === 'quarterly' ? { dayOfMonth } : {}),
        ...(frequency === 'custom' ? { weekdays: [...weekdays].sort() } : {}),
      };
      const outcome = await saveReportAction(projectId, initial?.id ?? null, {
        dashboardId,
        name: name.trim(),
        format,
        period,
        comparison,
        rhythm,
        timezone: timezone.trim(),
        deliveryMode,
        recipientUserIds: [...selected],
      });
      if (outcome.status === 'ok') {
        router.push(`/projects/${projectId}/reports` as Route);
        router.refresh();
      } else if (outcome.status === 'error') {
        setError(outcome.message);
        setFieldErrors(outcome.fieldErrors ?? {});
      }
    });
  };

  const toggle = (set: Set<string>, value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  return (
    <form className={styles.form} onSubmit={submit} aria-labelledby="report-form-title">
      <h2 id="report-form-title" className={styles.formTitle}>
        {initial ? t('form.editTitle', { name: initial.name }) : t('form.title')}
      </h2>

      <SelectField
        label={t('form.dashboard')}
        hint={t('form.dashboardHint')}
        value={dashboardId}
        onChange={(event) => setDashboardId(event.target.value)}
        options={options.dashboards.map((entry) => ({ value: entry.id, label: entry.name }))}
        error={fieldErrors.dashboardId}
        required
      />

      <TextField
        label={t('form.name')}
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={120}
        required
        error={fieldErrors.name}
      />

      <div className={styles.row}>
        <SelectField
          label={t('form.period')}
          hint={t('form.periodHint')}
          value={period}
          onChange={(event) => setPeriod(event.target.value as ReportScheduleInput['period'])}
          options={REPORT_PERIODS.map((entry) => ({ value: entry, label: t(`period.${entry}`) }))}
        />
        <SelectField
          label={t('form.comparison')}
          value={comparison}
          onChange={(event) =>
            setComparison(event.target.value as ReportScheduleInput['comparison'])
          }
          options={REPORT_COMPARISONS.map((entry) => ({
            value: entry,
            label: t(`comparison.${entry}`),
          }))}
        />
      </div>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('form.rhythm')}</legend>
        <div className={styles.row}>
          <SelectField
            label={t('form.frequency')}
            value={frequency}
            onChange={(event) => setFrequency(event.target.value as ReportFrequency)}
            options={REPORT_FREQUENCIES.map((entry) => ({
              value: entry,
              label: t(`frequency.${entry}`),
            }))}
          />
          <TextField
            label={t('form.time')}
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            required
          />
        </div>
        {frequency === 'weekly' ? (
          <SelectField
            label={t('form.weekday')}
            value={String(weekday)}
            onChange={(event) => setWeekday(Number(event.target.value))}
            options={WEEKDAYS.map((day) => ({ value: String(day), label: t(`weekday.${day}`) }))}
          />
        ) : null}
        {frequency === 'monthly' || frequency === 'quarterly' ? (
          <SelectField
            label={frequency === 'quarterly' ? t('form.dayOfQuarter') : t('form.dayOfMonth')}
            value={String(dayOfMonth)}
            onChange={(event) =>
              setDayOfMonth(event.target.value === 'last' ? 'last' : Number(event.target.value))
            }
            options={[
              ...Array.from({ length: 28 }, (_, index) => ({
                value: String(index + 1),
                label: t('form.dayNumber', { day: index + 1 }),
              })),
              { value: 'last', label: t('form.lastDay') },
            ]}
          />
        ) : null}
        {frequency === 'custom' ? (
          <div role="group" aria-label={t('form.weekdays')} className={styles.checkboxRow}>
            {WEEKDAYS.map((day) => (
              <label key={day} className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={weekdays.includes(day)}
                  onChange={() =>
                    setWeekdays((current) =>
                      current.includes(day)
                        ? current.filter((entry) => entry !== day)
                        : [...current, day],
                    )
                  }
                />
                {t(`weekday.${day}`)}
              </label>
            ))}
          </div>
        ) : null}
        <TextField
          label={t('form.timezone')}
          hint={t('form.timezoneHint')}
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          required
          error={fieldErrors.timezone}
        />
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('form.delivery')}</legend>
        <div className={styles.row}>
          <SelectField
            label={t('form.format')}
            hint={options.pptxEnabled ? undefined : t('form.pptxHeldBack')}
            value={format}
            onChange={(event) => setFormat(event.target.value as ReportFormat)}
            options={[
              { value: 'pdf', label: 'PDF' },
              { value: 'xlsx', label: 'Excel (XLSX)' },
              { value: 'pptx', label: 'PowerPoint (PPTX)', disabled: !options.pptxEnabled },
            ]}
            error={fieldErrors.format}
          />
          <SelectField
            label={t('form.deliveryMode')}
            value={deliveryMode}
            onChange={(event) => setDeliveryMode(event.target.value as ReportDeliveryMode)}
            options={[
              { value: 'attachment', label: t('deliveryMode.attachment') },
              { value: 'link', label: t('deliveryMode.link') },
            ]}
          />
        </div>
        <p className={styles.hint}>{t(`deliveryModeHint.${deliveryMode}`)}</p>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('form.recipients')}</legend>
        <p className={styles.hint}>{t('form.recipientsHint')}</p>
        {recipients.length === 0 ? (
          <p className={styles.hint}>{t('form.loadingRecipients')}</p>
        ) : null}
        {recipients.map((recipient) => (
          <label key={recipient.userId} className={styles.checkbox}>
            <input
              type="checkbox"
              disabled={!recipient.hasAccess}
              checked={selected.has(recipient.userId)}
              onChange={() => setSelected((current) => toggle(current, recipient.userId))}
            />
            {recipient.name}
            {recipient.hasAccess ? null : (
              <span className={styles.noAccess}>{t('form.noAccess')}</span>
            )}
          </label>
        ))}
        {fieldErrors.recipientUserIds ? (
          <p className={styles.fieldError} role="alert">
            {fieldErrors.recipientUserIds}
          </p>
        ) : null}
      </fieldset>

      {error ? (
        <Callout tone="critical" title={t('form.failedTitle')}>
          {error}
        </Callout>
      ) : null}

      <div className={styles.row}>
        <Button type="submit" variant="primary" disabled={pending || selected.size === 0}>
          {pending ? t('form.saving') : initial ? t('form.update') : t('form.create')}
        </Button>
      </div>
    </form>
  );
}
