import type { ComparisonMode, Locale, TimeRangePreset, ValueState } from '@axp/contracts';

/**
 * The words inside an export file (Master Spec §15).
 *
 * Export files are produced by the API, not by the web app, so they cannot
 * use the web app's message catalogue; this is the small part of it a file
 * needs. Both languages are first-class here too. The wording follows the
 * screen - a state reads the same in a PDF as on the dashboard.
 */
export interface ExportLabels {
  readonly meta: {
    readonly dashboard: string;
    readonly tenant: string;
    readonly project: string;
    readonly site: string;
    readonly timezone: string;
    readonly period: string;
    readonly comparison: string;
    readonly noComparison: string;
    readonly filters: string;
    readonly noFilters: string;
    readonly version: string;
    readonly versionLabel: string;
    readonly shareLabel: string;
    readonly generatedAt: string;
    readonly dataFetchedAt: string;
    readonly sharedView: string;
  };
  readonly overview: string;
  readonly contents: string;
  readonly metricsSheet: string;
  readonly columns: {
    readonly widget: string;
    readonly metric: string;
    readonly value: string;
    readonly unit: string;
    readonly evaluation: string;
    readonly comparisonValue: string;
    readonly change: string;
    readonly date: string;
    readonly state: string;
    readonly title: string;
    readonly description: string;
    readonly key: string;
  };
  readonly comparisonSeries: string;
  readonly definition: string;
  readonly context: string;
  readonly dataQuality: string;
  readonly noAnnotations: string;
  readonly chartAlt: string;
  readonly chartAltNotes: string;
  readonly tableCaption: string;
  readonly moreRows: string;
  readonly page: string;
  readonly continued: string;
  readonly footer: string;
  readonly hybridNote: string;
  readonly noComparableValue: string;
  readonly evaluationPrefix: string;
  readonly presets: Readonly<Record<TimeRangePreset, string>>;
  readonly comparisons: Readonly<Record<ComparisonMode, string>>;
  readonly states: Readonly<Record<ValueState, string>>;
  readonly units: Readonly<Record<string, string>>;
  /** Messages the presentation builder can attach to a widget. */
  readonly messages: Readonly<Record<string, string>>;
}

const DE: ExportLabels = {
  meta: {
    dashboard: 'Dashboard',
    tenant: 'Kunde',
    project: 'Projekt',
    site: 'Site',
    timezone: 'Zeitzone',
    period: 'Zeitraum',
    comparison: 'Vergleich',
    noComparison: 'Kein Vergleich',
    filters: 'Feste Filter',
    noFilters: 'Keine',
    version: 'Veröffentlichte Version {version}',
    versionLabel: 'Version',
    shareLabel: 'Freigabe',
    generatedAt: 'Erstellt',
    dataFetchedAt: 'Datenstand',
    sharedView: 'Geteilte Ansicht, gültig bis {date}',
  },
  overview: 'Übersicht',
  contents: 'Inhalt',
  metricsSheet: 'Kennzahlen',
  columns: {
    widget: 'Widget',
    metric: 'Kennzahl',
    value: 'Wert',
    unit: 'Einheit',
    evaluation: 'Bewertung',
    comparisonValue: 'Vergleichswert',
    change: 'Veränderung',
    date: 'Datum',
    state: 'Status',
    title: 'Titel',
    description: 'Beschreibung',
    key: 'Angabe',
  },
  comparisonSeries: 'Vergleichszeitraum',
  definition: 'Definition',
  context: 'Erläuterung',
  dataQuality: 'Hinweis zur Datenqualität',
  noAnnotations: 'Keine Ereignisse im Zeitraum.',
  chartAlt:
    'Liniendiagramm „{title}“ mit {points} Zeitpunkten. Die Werte stehen in der Tabelle darunter.',
  chartAltNotes:
    'Liniendiagramm „{title}“ mit {points} Zeitpunkten. Die Werte stehen in den Notizen dieser Folie.',
  tableCaption: 'Werte zu „{title}“',
  moreRows: 'Weitere Zeilen sind im Dashboard sichtbar.',
  page: 'Seite {page} von {pages}',
  continued: '{title} (Fortsetzung)',
  footer: 'Analytics Experience · {period}',
  hybridNote:
    'Diagramme sind als Bild eingefügt; die zugehörigen Werte stehen in den Notizen der Folie.',
  noComparableValue: 'Kein Vergleichswert',
  evaluationPrefix: 'Bewertung',
  presets: {
    today: 'Heute',
    yesterday: 'Gestern',
    last_7_days: 'Letzte 7 Tage',
    last_14_days: 'Letzte 14 Tage',
    last_30_days: 'Letzte 30 Tage',
    current_week: 'Aktuelle Woche',
    previous_week: 'Vorwoche',
    current_month: 'Aktueller Monat',
    previous_month: 'Vormonat',
    current_quarter: 'Aktuelles Quartal',
    previous_quarter: 'Vorquartal',
    current_year: 'Aktuelles Jahr',
    previous_year: 'Vorjahr',
    custom: 'Benutzerdefiniert',
  },
  comparisons: {
    none: 'Kein Vergleich',
    previous_period: 'Vorperiode',
    prior_year: 'Vorjahreszeitraum',
    custom: 'Benutzerdefiniert',
  },
  states: {
    loading: 'Wird geladen',
    ready: 'Bereit',
    empty: 'Keine Daten vorhanden',
    zero: '0',
    missing: 'Wert fehlt',
    unknown: 'Unbekannt',
    not_applicable: 'Nicht anwendbar',
    not_tracked: 'Nicht erfasst',
    unavailable: 'Daten aktuell nicht verfügbar',
    warning: 'Hinweis zur Interpretation',
  },
  units: {
    count: 'Anzahl',
    percent: '%',
    ratio: 'Verhältnis',
    seconds: 's',
    currency: 'Währung',
    score: 'Punkte',
  },
  messages: {
    'widget.no_metric_configured': 'Für dieses Widget ist noch keine Kennzahl konfiguriert.',
    'widget.permission_denied': 'Keine Berechtigung für die Daten dieses Widgets.',
    'widget.entitlement_required': 'Dieses Modul ist für den Vertrag nicht freigeschaltet.',
    'widget.source_unavailable': 'Daten aktuell nicht verfügbar.',
    'widget.unexpected_error': 'Dieses Widget konnte nicht geladen werden.',
    'widget.missing.no_mapping': 'Für „{requirement}“ ist keine Quelle zugeordnet.',
    'widget.missing.source_field_absent': '„{requirement}“ ist auf dieser Website nicht vorhanden.',
    'widget.missing.not_calculable': 'Nicht berechenbar – es fehlt: {inputs}.',
    'quality.period_partially_processed':
      'Der letzte Tag des Zeitraums ist noch nicht vollständig verarbeitet. Die Zahl kann sich noch leicht ändern.',
    'quality.unspecified': 'Zu diesem Wert gibt es einen Hinweis ohne weitere Angaben.',
    'analytics.binding_kind_not_executable':
      'Diese Zuordnungsart kann noch nicht aus Matomo abgerufen werden.',
    'matomo.capability.page_ranking_unavailable':
      'Seiten-Rankings sind in dieser Matomo-Instanz nicht verfügbar.',
    'analytics.site_not_assigned': 'Die Site ist diesem Projekt nicht zugeordnet.',
    'analytics.timeout': 'Die Abfrage hat zu lange gedauert.',
    'matomo.unreachable': 'Die Matomo-Instanz ist nicht erreichbar.',
    'matomo.source_unavailable': 'Dieser Bericht antwortet zurzeit nicht.',
  },
};

const EN: ExportLabels = {
  meta: {
    dashboard: 'Dashboard',
    tenant: 'Customer',
    project: 'Project',
    site: 'Site',
    timezone: 'Time zone',
    period: 'Time range',
    comparison: 'Comparison',
    noComparison: 'No comparison',
    filters: 'Fixed filters',
    noFilters: 'None',
    version: 'Published version {version}',
    versionLabel: 'Version',
    shareLabel: 'Share',
    generatedAt: 'Created',
    dataFetchedAt: 'Data as of',
    sharedView: 'Shared view, valid until {date}',
  },
  overview: 'Overview',
  contents: 'Contents',
  metricsSheet: 'Metrics',
  columns: {
    widget: 'Widget',
    metric: 'Metric',
    value: 'Value',
    unit: 'Unit',
    evaluation: 'Evaluation',
    comparisonValue: 'Comparison value',
    change: 'Change',
    date: 'Date',
    state: 'State',
    title: 'Title',
    description: 'Description',
    key: 'Item',
  },
  comparisonSeries: 'Comparison period',
  definition: 'Definition',
  context: 'Explanation',
  dataQuality: 'Data quality note',
  noAnnotations: 'No events in this period.',
  chartAlt: 'Line chart "{title}" with {points} points. The values are in the table below.',
  chartAltNotes:
    'Line chart "{title}" with {points} points. The values are in the notes of this slide.',
  tableCaption: 'Values for "{title}"',
  moreRows: 'More rows are visible on the dashboard.',
  page: 'Page {page} of {pages}',
  continued: '{title} (continued)',
  footer: 'Analytics Experience · {period}',
  hybridNote: 'Charts are inserted as images; their values are in the slide notes.',
  noComparableValue: 'No comparable value',
  evaluationPrefix: 'Evaluation',
  presets: {
    today: 'Today',
    yesterday: 'Yesterday',
    last_7_days: 'Last 7 days',
    last_14_days: 'Last 14 days',
    last_30_days: 'Last 30 days',
    current_week: 'Current week',
    previous_week: 'Previous week',
    current_month: 'Current month',
    previous_month: 'Previous month',
    current_quarter: 'Current quarter',
    previous_quarter: 'Previous quarter',
    current_year: 'Current year',
    previous_year: 'Previous year',
    custom: 'Custom',
  },
  comparisons: {
    none: 'No comparison',
    previous_period: 'Previous period',
    prior_year: 'Same period last year',
    custom: 'Custom',
  },
  states: {
    loading: 'Loading',
    ready: 'Ready',
    empty: 'No data available',
    zero: '0',
    missing: 'Value missing',
    unknown: 'Unknown',
    not_applicable: 'Not applicable',
    not_tracked: 'Not tracked',
    unavailable: 'Data currently unavailable',
    warning: 'Interpretation note',
  },
  units: {
    count: 'Count',
    percent: '%',
    ratio: 'Ratio',
    seconds: 's',
    currency: 'Currency',
    score: 'Points',
  },
  messages: {
    'widget.no_metric_configured': 'No metric is configured for this widget yet.',
    'widget.permission_denied': "No permission for this widget's data.",
    'widget.entitlement_required': 'This module is not enabled for the contract.',
    'widget.source_unavailable': 'Data currently unavailable.',
    'widget.unexpected_error': 'This widget could not be loaded.',
    'widget.missing.no_mapping': 'No source is mapped for "{requirement}".',
    'widget.missing.source_field_absent': '"{requirement}" is not present on this site.',
    'widget.missing.not_calculable': 'Not calculable - missing: {inputs}.',
    'quality.period_partially_processed':
      'The last day of the period has not finished processing. The number may still change slightly.',
    'quality.unspecified': 'There is a note on this value with no further detail.',
    'analytics.binding_kind_not_executable':
      'This kind of mapping cannot be fetched from Matomo yet.',
    'matomo.capability.page_ranking_unavailable':
      'Page rankings are not available in this Matomo installation.',
    'analytics.site_not_assigned': 'The site is not assigned to this project.',
    'analytics.timeout': 'The query took too long.',
    'matomo.unreachable': 'The Matomo installation is unreachable.',
    'matomo.source_unavailable': 'This report is not answering right now.',
  },
};

export function exportLabels(locale: Locale): ExportLabels {
  return locale === 'en' ? EN : DE;
}

/** Fills `{name}` placeholders. Unknown placeholders stay visible, never blank. */
export function fill(template: string, params: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
