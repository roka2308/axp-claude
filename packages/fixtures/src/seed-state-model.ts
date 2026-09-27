import {
  CORE_NATIVE_METRICS,
  type DashboardSnapshot,
  type SemanticDefinitionBody,
  type WidgetConfig,
} from '@axp/contracts';
import { type Container, MOCK_STATE_METRICS } from '@axp/core';

/**
 * The state-model dashboard (D10, Gate F4).
 *
 * One widget per value state, side by side, so the ten states of the state
 * model can be seen together rather than argued about. Gate F4 asks for exactly
 * this: "all D10 states demonstrable in fixture environment".
 *
 * How each state is produced:
 *
 *   - `loading`    every tile, while its own query is still running
 *   - `ready`      a native metric on a healthy mock site
 *   - `zero`       a report that measured nothing - a value, not an absence
 *   - `empty`      a valid query that legitimately returned no data
 *   - `missing`    a custom metric whose requirement nobody has mapped
 *   - `unknown`    a value that came back and could not be interpreted
 *   - `not_applicable`  a report that does not apply to this kind of site
 *   - `not_tracked`     a report the site does not collect
 *   - `unavailable`     a report that answered 503 while the rest is fine
 *   - `warning`    a number worth showing, with a caveat worth reading
 *
 * Only `missing` and `not_applicable` come from the product; the rest come
 * from the source, through reserved mock metrics. That split is the point: the
 * product must render a state it was handed, not decide what state to show.
 */

export const STATE_MODEL_DASHBOARD_NAME = 'Zustandsmodell';

/** Requirement keys the fixture maps - or deliberately leaves unmapped. */
const REQUIREMENTS = {
  zero: 'states.measured_zero',
  empty: 'states.no_data',
  unknown: 'states.unreadable',
  notTracked: 'states.not_collected',
  notApplicable: 'states.not_for_this_site',
  unavailable: 'states.report_down',
  warning: 'states.partially_processed',
  /** Never mapped. That is what makes it `missing` (Master Spec §13). */
  missing: 'states.never_mapped',
} as const;

export interface SeedStateModelResult {
  readonly dashboardId: string;
  readonly publishedVersion: number;
  /** Widget id per state, so a test or a gate can address one directly. */
  readonly widgetIds: Readonly<Record<string, string>>;
}

export async function seedStateModelDashboard(
  container: Container,
  params: {
    tenantId: string;
    projectId: string;
    siteId: string;
    actorUserId: string;
  },
): Promise<SeedStateModelResult> {
  const { tenantId, projectId, siteId, actorUserId } = params;

  /*
   * A custom metric per state, each pointing at its requirement. The mapping is
   * what decides the outcome, which is exactly the separation the semantic layer
   * exists to keep: the definition says what is wanted, the binding says where
   * it comes from.
   */
  const versions: Record<string, string> = {};

  for (const [state, requirementKey] of Object.entries(REQUIREMENTS)) {
    const body: SemanticDefinitionBody = {
      kind: 'custom',
      requirementKey,
      unit: 'count',
      scope: 'visit',
      direction: 'higher_is_better',
      decimals: 0,
    };

    const portableId = `states.${state}`;
    const existing = await container.semantics.getActiveVersionByPortableId(portableId, {
      tenantId,
      projectId,
    });

    if (existing) {
      versions[state] = existing.version.id;
      continue;
    }

    const created = await container.semantics.createDefinition({
      tenantId,
      projectId,
      portableId,
      type: 'custom_metric',
      name: NAMES[state] ?? state,
      description: DESCRIPTIONS[state] ?? '',
      body,
      actorUserId,
    });
    await container.semantics.changeVersionStatus({
      tenantId,
      definitionId: created.definition.id,
      versionId: created.version.id,
      to: 'active',
      actorUserId,
    });
    versions[state] = created.version.id;
  }

  // Every requirement but one gets a mapping. `missing` stays unmapped, which
  // is the whole reason it is in this fixture.
  const mappings: Record<string, string> = {
    zero: MOCK_STATE_METRICS.zero,
    empty: MOCK_STATE_METRICS.empty,
    unknown: MOCK_STATE_METRICS.unknown,
    notTracked: MOCK_STATE_METRICS.notTracked,
    notApplicable: MOCK_STATE_METRICS.notApplicable,
    unavailable: MOCK_STATE_METRICS.unavailable,
    warning: MOCK_STATE_METRICS.warning,
  };

  for (const [state, sourceMetric] of Object.entries(mappings)) {
    await container.semantics.setSourceBinding({
      tenantId,
      projectId,
      siteId: null,
      requirementKey: REQUIREMENTS[state as keyof typeof REQUIREMENTS],
      binding: { kind: 'native_metric', sourceMetric },
      actorUserId,
    });
  }

  await container.semantics.ensureCoreNativeMetrics();
  const visits = await container.semantics.getActiveVersionByPortableId(CORE_NATIVE_METRICS.visits);
  if (!visits) throw new Error('Core native metrics are missing after seeding.');

  const existing = await container.dashboards.listForProject(tenantId, projectId);
  const already = existing.find((dashboard) => dashboard.name === STATE_MODEL_DASHBOARD_NAME);

  const draft = already
    ? await container.dashboards.getDraft(tenantId, already.id)
    : await container.dashboards.createDashboard({
        tenantId,
        projectId,
        siteId,
        name: STATE_MODEL_DASHBOARD_NAME,
        description:
          'Jeder Wertzustand des Zustandsmodells in einem eigenen Widget. ' +
          'Zum Prüfen, nicht zum Auswerten.',
        actorUserId,
      });

  const widgets = buildWidgets(visits.version.id, versions);

  const saved = await container.dashboards.saveDraft({
    tenantId,
    dashboardId: draft.dashboardId,
    expectedRevisionId: draft.revisionId,
    snapshot: { ...draft.snapshot, siteId, widgets } satisfies DashboardSnapshot,
    actorUserId,
  });

  const published = await container.dashboards.publish({
    tenantId,
    dashboardId: saved.dashboardId,
    actorUserId,
  });

  return {
    dashboardId: published.dashboardId,
    publishedVersion: published.version,
    widgetIds: Object.fromEntries(
      widgets.map((widget) => [widget.id.replace('state-', ''), widget.id]),
    ),
  };
}

const NAMES: Readonly<Record<string, string>> = {
  zero: 'Gemessene Null',
  empty: 'Keine Daten',
  unknown: 'Nicht lesbarer Wert',
  notTracked: 'Nicht erfasst',
  notApplicable: 'Nicht anwendbar',
  unavailable: 'Bericht nicht erreichbar',
  warning: 'Mit Einschränkung',
  missing: 'Ohne Zuordnung',
};

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  zero: 'Der Bericht hat null gemessen. Das ist ein Wert und kein fehlender Wert.',
  empty: 'Die Abfrage war gültig und hat keine Daten geliefert.',
  unknown: 'Die Quelle hat etwas geliefert, das sich nicht als Zahl lesen lässt.',
  notTracked: 'Diese Website erfasst diesen Bericht nicht.',
  notApplicable: 'Dieser Bericht ist für diese Art von Website nicht sinnvoll.',
  unavailable: 'Der Bericht antwortet zurzeit nicht. Die übrigen Widgets sind davon unberührt.',
  warning: 'Die Zahl ist belastbar, der Zeitraum ist aber noch nicht vollständig verarbeitet.',
  missing: 'Für diese Anforderung ist keine Quelle zugeordnet.',
};

/**
 * Three per row on the desktop raster, in the order the state model lists them.
 *
 * Reading order matters here more than usual: the dashboard is read as a list of
 * states, and the tab order follows the same sequence.
 */
function buildWidgets(
  visitsVersionId: string,
  versions: Readonly<Record<string, string>>,
): WidgetConfig[] {
  const card = (
    id: string,
    title: string,
    versionId: string | undefined,
    index: number,
  ): WidgetConfig => ({
    id: `state-${id}`,
    family: 'card',
    title,
    placement: { desktop: { x: (index % 3) * 4, y: Math.floor(index / 3) * 3, w: 4, h: 3 } },
    data: { semanticVersionIds: versionId ? [versionId] : [], fixedFilters: [] },
    presentation: { variant: 'kpi', showComparison: false, decimals: 0 },
    context: { showDefinition: true, description: DESCRIPTIONS[id] ?? '' },
  });

  return [
    card('ready', 'Bereit', visitsVersionId, 0),
    card('zero', NAMES.zero!, versions.zero, 1),
    card('empty', NAMES.empty!, versions.empty, 2),
    card('missing', NAMES.missing!, versions.missing, 3),
    card('unknown', NAMES.unknown!, versions.unknown, 4),
    card('notTracked', NAMES.notTracked!, versions.notTracked, 5),
    card('notApplicable', NAMES.notApplicable!, versions.notApplicable, 6),
    card('unavailable', NAMES.unavailable!, versions.unavailable, 7),
    card('warning', NAMES.warning!, versions.warning, 8),
    /*
     * A tenth widget with no metric at all. Not a state of a value but a state
     * of a widget - "nothing has been configured here yet" - and the product
     * distinguishes the two (D10).
     */
    {
      id: 'state-unconfigured',
      family: 'card',
      title: 'Ohne Kennzahl',
      placement: { desktop: { x: 0, y: 9, w: 4, h: 3 } },
      data: { semanticVersionIds: [], fixedFilters: [] },
      presentation: { variant: 'kpi', showComparison: false, decimals: 0 },
      context: {
        showDefinition: false,
        description: 'Für dieses Widget ist noch keine Kennzahl ausgewählt.',
      },
    },
  ];
}
