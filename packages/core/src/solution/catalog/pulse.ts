import type { PortableFormulaNode, SolutionPackage } from '@axp/contracts';

/**
 * Employee Portal Health / Pulse - the first reference solution (Master Spec
 * §14, `06_Canonical_Demo_Data_Pulse_v1.0.md`).
 *
 * Written as an ordinary package: it is validated, analysed and installed
 * through exactly the path an uploaded package takes, so the reference
 * solution proves that path rather than bypassing it.
 *
 * Weights and decimals are the reference configuration from the canonical
 * fixture, not product defaults. The evaluation bands are demo configuration:
 * the POC established no canonical thresholds, and the descriptions say so.
 */

const ref = (portableId: string): PortableFormulaNode => ({ type: 'reference', portableId });
const num = (value: number): PortableFormulaNode => ({ type: 'constant', value });
const op = (
  operator: '+' | '-' | '*' | '/',
  left: PortableFormulaNode,
  right: PortableFormulaNode,
): PortableFormulaNode => ({ type: 'binary', op: operator, left, right });

const percentOf = (part: string, whole: string) =>
  op('*', op('/', ref(part), ref(whole)), num(100));

const people = {
  unit: 'count',
  scope: 'site',
  direction: 'higher_is_better',
  decimals: 0,
} as const;

const rate = {
  unit: 'percent',
  scope: 'site',
  direction: 'higher_is_better',
  // Rates are shown as whole percent, and the chain builds on what is shown
  // (canonical fixture: "Engagement Rate display basis 18"; ADR 0007).
  decimals: 0,
} as const;

export const PULSE_PACKAGE_ID = 'com.axp.employee-portal-health';

export const PULSE_PACKAGE: SolutionPackage = {
  manifest: {
    packageId: PULSE_PACKAGE_ID,
    packageVersion: '1.0.0',
    packageSchemaVersion: '1',
    name: 'Employee Portal Health (Pulse)',
    description:
      'Misst, wie lebendig ein Mitarbeiterportal ist: Engagement, Beteiligung und Verbreitung, verdichtet zum PULSE-Index.',
    publisher: 'Analytics Experience Platform',
    createdAt: '2026-09-28T00:00:00Z',
    productCompatibility: { min: '0.1.0' },
    dependencies: [],
    requiredCapabilities: ['time_series', 'page_ranking'],
    includedObjects: [
      ...[
        'pulse.active_users',
        'pulse.engaged_users',
        'pulse.content_creators',
        'pulse.registered_users',
      ].map((portableId) => ({ type: 'requirement' as const, portableId })),
      ...[
        'pulse.active_users',
        'pulse.engaged_users',
        'pulse.content_creators',
        'pulse.registered_users',
        'pulse.engagement_rate',
        'pulse.creation_rate',
        'pulse.adoption_rate',
        'pulse.interaction_index',
        'pulse.health_index',
      ].map((portableId) => ({ type: 'semantic_definition' as const, portableId })),
      ...[
        'pulse.widget.health_score',
        'pulse.widget.interaction_index',
        'pulse.widget.adoption_rate',
        'pulse.widget.engagement_trend',
      ].map((portableId) => ({ type: 'widget_template' as const, portableId })),
      ...['pulse.dashboard.executive_health', 'pulse.dashboard.engagement_detail'].map(
        (portableId) => ({ type: 'dashboard_template' as const, portableId }),
      ),
    ],
    origin: { kind: 'publisher', note: 'Reference solution from the Pulse proof of concept.' },
  },

  requirements: [
    {
      key: 'pulse.active_users',
      label: 'Aktive Nutzer:innen',
      description: 'Personen, die das Portal im Zeitraum mindestens einmal genutzt haben.',
    },
    {
      key: 'pulse.engaged_users',
      label: 'Engagierte Nutzer:innen',
      description: 'Personen, die im Zeitraum interagiert haben: kommentiert, reagiert, geteilt.',
    },
    {
      key: 'pulse.content_creators',
      label: 'Beitragende',
      description: 'Personen, die im Zeitraum selbst Inhalte erstellt haben.',
    },
    {
      key: 'pulse.registered_users',
      label: 'Registrierte Nutzer:innen',
      description: 'Alle Personen mit Zugang zum Portal.',
    },
  ],

  definitions: [
    {
      portableId: 'pulse.active_users',
      type: 'custom_metric',
      name: 'Aktive Nutzer:innen',
      description: 'Personen, die das Portal im Zeitraum mindestens einmal genutzt haben.',
      body: { kind: 'custom', requirementKey: 'pulse.active_users', ...people },
    },
    {
      portableId: 'pulse.engaged_users',
      type: 'custom_metric',
      name: 'Engagierte Nutzer:innen',
      description: 'Personen, die im Zeitraum mit Inhalten interagiert haben.',
      body: { kind: 'custom', requirementKey: 'pulse.engaged_users', ...people },
    },
    {
      portableId: 'pulse.content_creators',
      type: 'custom_metric',
      name: 'Beitragende',
      description: 'Personen, die im Zeitraum selbst Inhalte erstellt haben.',
      body: { kind: 'custom', requirementKey: 'pulse.content_creators', ...people },
    },
    {
      portableId: 'pulse.registered_users',
      type: 'custom_metric',
      name: 'Registrierte Nutzer:innen',
      description: 'Alle Personen mit Zugang zum Portal.',
      body: { kind: 'custom', requirementKey: 'pulse.registered_users', ...people },
    },
    {
      portableId: 'pulse.engagement_rate',
      type: 'formula',
      name: 'Engagement Rate',
      description:
        'Anteil der aktiven Nutzer:innen, die interagiert haben: Engagierte / Aktive × 100.',
      body: {
        kind: 'formula',
        ast: percentOf('pulse.engaged_users', 'pulse.active_users'),
        ...rate,
      },
    },
    {
      portableId: 'pulse.creation_rate',
      type: 'formula',
      name: 'Creation Rate',
      description:
        'Anteil der aktiven Nutzer:innen, die selbst Inhalte erstellt haben: Beitragende / Aktive × 100.',
      body: {
        kind: 'formula',
        ast: percentOf('pulse.content_creators', 'pulse.active_users'),
        ...rate,
      },
    },
    {
      portableId: 'pulse.adoption_rate',
      type: 'formula',
      name: 'Adoption Rate',
      description: 'Wie weit das Portal verbreitet ist: Aktive / Registrierte × 100.',
      body: {
        kind: 'formula',
        ast: percentOf('pulse.active_users', 'pulse.registered_users'),
        ...rate,
      },
    },
    {
      portableId: 'pulse.interaction_index',
      type: 'formula',
      name: 'Interaction Index',
      description:
        'Wie aktiv sich die Nutzer:innen beteiligen: Engagement Rate × 0,8 + Creation Rate × 0,2. Die Gewichte sind Konfiguration dieser Lösung.',
      body: {
        kind: 'formula',
        ast: op(
          '+',
          op('*', ref('pulse.engagement_rate'), num(0.8)),
          op('*', ref('pulse.creation_rate'), num(0.2)),
        ),
        unit: 'ratio',
        scope: 'site',
        direction: 'higher_is_better',
        decimals: 1,
      },
    },
    {
      portableId: 'pulse.health_index',
      type: 'score',
      name: 'PULSE',
      description:
        'Gesundheit des Portals auf einer Skala von 0 bis 100: Interaction Index × 0,3 + Adoption Rate × 0,7. Die Bewertungsstufen sind Demo-Konfiguration, keine Erkenntnis aus dem POC.',
      body: {
        kind: 'score',
        components: [
          {
            portableId: 'pulse.interaction_index',
            weight: 0.3,
            normalisation: { kind: 'linear', worst: 0, best: 100 },
            label: 'Interaction Index',
          },
          {
            portableId: 'pulse.adoption_rate',
            weight: 0.7,
            normalisation: { kind: 'linear', worst: 0, best: 100 },
            label: 'Adoption Rate',
          },
        ],
        evaluation: [
          { key: 'kritisch', atLeast: 0, band: 1 },
          { key: 'ausbaufähig', atLeast: 25, band: 2 },
          { key: 'solide', atLeast: 40, band: 3 },
          { key: 'gut', atLeast: 60, band: 4 },
          { key: 'sehr gut', atLeast: 80, band: 5 },
        ],
        unit: 'score',
        scope: 'site',
        direction: 'higher_is_better',
        decimals: 2,
      },
    },
  ],

  widgetTemplates: [
    {
      portableId: 'pulse.widget.health_score',
      name: 'PULSE mit Bewertung',
      description: 'Der Gesundheitsindex mit seiner Bewertungsstufe.',
      family: 'card',
      variant: 'score_evaluation',
      metrics: ['pulse.health_index'],
      showComparison: true,
    },
    {
      portableId: 'pulse.widget.interaction_index',
      name: 'Interaction Index',
      family: 'card',
      variant: 'kpi_comparison',
      metrics: ['pulse.interaction_index'],
      showComparison: true,
    },
    {
      portableId: 'pulse.widget.adoption_rate',
      name: 'Adoption Rate',
      family: 'card',
      variant: 'kpi_comparison',
      metrics: ['pulse.adoption_rate'],
      showComparison: true,
    },
    {
      portableId: 'pulse.widget.engagement_trend',
      name: 'Engagement Rate im Verlauf',
      family: 'time_series',
      metrics: ['pulse.engagement_rate'],
      showComparison: false,
    },
  ],

  dashboardTemplates: [
    {
      portableId: 'pulse.dashboard.executive_health',
      name: 'Executive Health Overview',
      description: 'Der PULSE-Index und die vier Kennzahlen, aus denen er entsteht.',
      defaultTimeRange: 'last_7_days',
      defaultComparison: 'previous_period',
      widgets: [
        {
          id: 'pulse-score',
          title: 'PULSE',
          family: 'card',
          variant: 'score_evaluation',
          metrics: ['pulse.health_index'],
          showComparison: true,
          placement: { x: 0, y: 0, w: 4, h: 4 },
        },
        {
          id: 'interaction-index',
          title: 'Interaction Index',
          family: 'card',
          variant: 'kpi_comparison',
          metrics: ['pulse.interaction_index'],
          showComparison: true,
          placement: { x: 4, y: 0, w: 4, h: 2 },
        },
        {
          id: 'adoption-rate',
          title: 'Adoption Rate',
          family: 'card',
          variant: 'kpi_comparison',
          metrics: ['pulse.adoption_rate'],
          showComparison: true,
          placement: { x: 8, y: 0, w: 4, h: 2 },
        },
        {
          id: 'engagement-rate',
          title: 'Engagement Rate',
          family: 'card',
          variant: 'kpi_comparison',
          metrics: ['pulse.engagement_rate'],
          showComparison: true,
          placement: { x: 4, y: 2, w: 4, h: 2 },
        },
        {
          id: 'creation-rate',
          title: 'Creation Rate',
          family: 'card',
          variant: 'kpi_comparison',
          metrics: ['pulse.creation_rate'],
          showComparison: true,
          placement: { x: 8, y: 2, w: 4, h: 2 },
        },
        {
          id: 'pulse-trend',
          title: 'PULSE im Verlauf',
          family: 'time_series',
          metrics: ['pulse.health_index'],
          showComparison: false,
          placement: { x: 0, y: 4, w: 8, h: 5 },
        },
        {
          id: 'pulse-context',
          title: 'So entsteht PULSE',
          family: 'context_text',
          metrics: [],
          showComparison: false,
          text: 'PULSE verdichtet Beteiligung und Verbreitung: Interaction Index × 0,3 + Adoption Rate × 0,7. Der Interaction Index gewichtet Engagement Rate mit 0,8 und Creation Rate mit 0,2. Jede Stufe rechnet mit dem angezeigten Wert der vorigen. Gewichte und Bewertungsstufen sind Konfiguration dieser Lösung. Im Demo sind die Zeitreihen synthetisch.',
          placement: { x: 8, y: 4, w: 4, h: 5 },
        },
      ],
    },
    {
      portableId: 'pulse.dashboard.engagement_detail',
      name: 'Engagement & Participation Detail',
      description: 'Wie sich Engagement und Beteiligung entwickeln, und wo sie entstehen.',
      defaultTimeRange: 'last_7_days',
      defaultComparison: 'previous_period',
      widgets: [
        {
          id: 'engagement-trend',
          title: 'Engagement Rate im Verlauf',
          family: 'time_series',
          metrics: ['pulse.engagement_rate'],
          showComparison: false,
          placement: { x: 0, y: 0, w: 6, h: 5 },
        },
        {
          id: 'creation-trend',
          title: 'Creation Rate im Verlauf',
          family: 'time_series',
          metrics: ['pulse.creation_rate'],
          showComparison: false,
          placement: { x: 6, y: 0, w: 6, h: 5 },
        },
        {
          id: 'active-vs-registered',
          title: 'Aktive und registrierte Nutzer:innen',
          family: 'time_series',
          metrics: ['pulse.active_users', 'pulse.registered_users'],
          showComparison: false,
          placement: { x: 0, y: 5, w: 6, h: 5 },
        },
        {
          id: 'interaction-breakdown',
          title: 'Beteiligung nach Seite',
          family: 'flexible_table',
          metrics: ['pulse.engaged_users', 'pulse.content_creators'],
          dimension: 'page_url',
          topN: 8,
          showComparison: false,
          placement: { x: 6, y: 5, w: 6, h: 5 },
        },
        {
          id: 'definitions',
          title: 'Definitionen und Hinweise',
          family: 'context_text',
          metrics: [],
          showComparison: false,
          text: 'Engagement Rate = Engagierte / Aktive × 100. Creation Rate = Beitragende / Aktive × 100. Adoption Rate = Aktive / Registrierte × 100. Nutzer:innen-Zahlen sind Personen im Zeitraum, keine Summen über Tage. Im Demo sind die Zeitreihen synthetisch.',
          placement: { x: 0, y: 10, w: 12, h: 2 },
        },
      ],
    },
  ],

  contextProfile: {
    useCase:
      'Gesundheit des Mitarbeiterportals beobachten: Wird es genutzt, beteiligen sich die Menschen, erreicht es alle?',
    audience: 'Interne Kommunikation, Portal-Verantwortliche, Geschäftsleitung',
    goals: 'Beteiligung steigern, Verbreitung im ganzen Unternehmen erreichen',
    success: 'PULSE steigt über mehrere Wochen; Adoption Rate über 60 %',
  },

  glossary: [
    {
      term: 'PULSE',
      definition:
        'Gesundheitsindex des Portals von 0 bis 100, aus Interaction Index und Adoption Rate.',
    },
    {
      term: 'Interaction Index',
      definition: 'Gewichtete Beteiligung: 80 % Engagement Rate, 20 % Creation Rate.',
    },
  ],
};

/** The first-party catalogue: packages offered without an upload. */
export const SOLUTION_CATALOG: readonly SolutionPackage[] = [PULSE_PACKAGE];
