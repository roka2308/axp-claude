import { z } from 'zod';
import { comparisonModeSchema, timeRangePresetSchema } from './analytics';
import { cardVariantSchema, widgetFamilySchema } from './dashboard';
import { matomoCapabilitySchema } from './matomo';
import { contextProfileSchema } from './project';
import {
  semanticDirectionSchema,
  semanticScopeSchema,
  semanticTypeSchema,
  semanticUnitSchema,
} from './semantic';

/**
 * Analytics Solution Package, schema version 1 (Master Spec §14 and §23,
 * Shared Contract §13).
 *
 * A package is **untrusted declarative input**. Everything in it is data the
 * product already knows how to interpret - definitions, formula trees, score
 * weights, templates, text - and nothing in it is ever executed. That is
 * enforced by shape, not by scanning: every object is `strict`, so a key the
 * schema does not name (`script`, `__proto__`, `connectionId`, `token`) makes
 * the whole package invalid, and there is no field anywhere that could hold
 * code, SQL, a URL to fetch or a credential.
 *
 * Objects are referred to by portable id, never by database id: the same
 * package installs identically into any project of any installation, and the
 * local ids it produces are recorded at install time.
 *
 * What a package can never carry, by construction: analytics data, raw
 * visit/action data, credentials, users, sessions, groups, memberships, shares,
 * schedules, audit, customer-specific connection or site ids.
 */

export const SOLUTION_PACKAGE_SCHEMA_VERSION = '1';

/** Hard ceilings, checked before any parsing of the content. */
export const SOLUTION_PACKAGE_LIMITS = {
  maxBytes: 512 * 1024,
  maxDefinitions: 200,
  maxRequirements: 100,
  maxWidgetTemplates: 100,
  maxDashboardTemplates: 50,
  maxWidgetsPerDashboard: 40,
  maxFormulaDepth: 12,
  maxFormulaNodes: 200,
} as const;

const PORTABLE_ID = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/;
const PACKAGE_ID = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const SEMVER = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;

export const portableIdSchema = z.string().max(128).regex(PORTABLE_ID);
export const packageIdSchema = z.string().max(128).regex(PACKAGE_ID);
export const packageVersionSchema = z.string().max(20).regex(SEMVER);

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

// --- semantic definitions, in portable form ---------------------------------

export type PortableFormulaNode =
  | { readonly type: 'constant'; readonly value: number }
  | { readonly type: 'reference'; readonly portableId: string }
  | {
      readonly type: 'binary';
      readonly op: '+' | '-' | '*' | '/';
      readonly left: PortableFormulaNode;
      readonly right: PortableFormulaNode;
    }
  | {
      readonly type: 'function';
      readonly name: 'MIN' | 'MAX' | 'AVG' | 'ROUND' | 'COALESCE';
      readonly args: readonly PortableFormulaNode[];
    };

export const portableFormulaNodeSchema: z.ZodType<PortableFormulaNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('constant'), value: z.number().finite() }).strict(),
    z.object({ type: z.literal('reference'), portableId: portableIdSchema }).strict(),
    z
      .object({
        type: z.literal('binary'),
        op: z.enum(['+', '-', '*', '/']),
        left: portableFormulaNodeSchema,
        right: portableFormulaNodeSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('function'),
        name: z.enum(['MIN', 'MAX', 'AVG', 'ROUND', 'COALESCE']),
        args: z.array(portableFormulaNodeSchema).min(1).max(8),
      })
      .strict(),
  ]),
);

const measureShape = {
  unit: semanticUnitSchema,
  scope: semanticScopeSchema,
  direction: semanticDirectionSchema,
  decimals: z.number().int().min(0).max(6),
};

const scoreNormalisationSchema = z.union([
  z
    .object({ kind: z.literal('linear'), worst: z.number().finite(), best: z.number().finite() })
    .strict(),
  z
    .object({
      kind: z.literal('bands'),
      bands: z
        .array(
          z.object({ atLeast: z.number().finite(), points: z.number().min(0).max(100) }).strict(),
        )
        .min(1)
        .max(10),
    })
    .strict(),
]);

export const portableDefinitionBodySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('native'),
      /** A normalised connector metric name - never a vendor field or an id. */
      sourceMetric: z
        .string()
        .max(64)
        .regex(/^[a-z][a-z0-9_]*$/),
      ...measureShape,
    })
    .strict(),
  z
    .object({
      kind: z.literal('custom'),
      /** Must be declared in `requirements`; mapped locally at install time. */
      requirementKey: portableIdSchema,
      ...measureShape,
    })
    .strict(),
  z
    .object({ kind: z.literal('formula'), ast: portableFormulaNodeSchema, ...measureShape })
    .strict(),
  z
    .object({
      kind: z.literal('score'),
      components: z
        .array(
          z
            .object({
              portableId: portableIdSchema,
              weight: z.number().finite().positive(),
              normalisation: scoreNormalisationSchema,
              label: optionalText(120),
            })
            .strict(),
        )
        .min(1)
        .max(12),
      /** An evaluation scheme of three to five bands, or none at all. */
      evaluation: z
        .array(
          z
            .object({
              key: text(40),
              atLeast: z.number().min(0).max(100),
              band: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
            })
            .strict(),
        )
        .max(5)
        .refine((bands) => bands.length === 0 || bands.length >= 3, {
          message: 'An evaluation scheme has three to five bands.',
        }),
      unit: z.literal('score'),
      scope: semanticScopeSchema,
      direction: semanticDirectionSchema,
      decimals: z.number().int().min(0).max(6),
    })
    .strict(),
]);

export type PortableDefinitionBody = z.infer<typeof portableDefinitionBodySchema>;

export const portableDefinitionSchema = z
  .object({
    portableId: portableIdSchema,
    type: semanticTypeSchema,
    name: text(200),
    /** The glossary entry: what the number means, in the business's words. */
    description: optionalText(1000),
    body: portableDefinitionBodySchema,
  })
  .strict();

export type PortableDefinition = z.infer<typeof portableDefinitionSchema>;

/**
 * Something the installing project has to point at itself.
 *
 * Described in business terms only. Which Matomo report, event category or
 * custom dimension satisfies it is decided at install time, on the target
 * site - a package never names a dimension id (Gate F6).
 */
export const packageRequirementSchema = z
  .object({
    key: portableIdSchema,
    label: text(120),
    description: optionalText(500),
  })
  .strict();

export type PackageRequirement = z.infer<typeof packageRequirementSchema>;

// --- templates ----------------------------------------------------------------

const placementSchema = z
  .object({
    x: z.number().int().min(0).max(11),
    y: z.number().int().min(0).max(200),
    w: z.number().int().min(1).max(12),
    h: z.number().int().min(1).max(12),
  })
  .strict();

const widgetShape = {
  family: widgetFamilySchema,
  variant: cardVariantSchema.optional(),
  /** Portable ids of the definitions shown; resolved when the widget is inserted. */
  metrics: z.array(portableIdSchema).max(4),
  dimension: z.enum(['page_url', 'page_title']).optional(),
  topN: z.number().int().min(1).max(50).optional(),
  showComparison: z.boolean(),
  showSparkline: z.boolean().optional(),
  /** Explanation shown with the widget; for `context_text`, the text itself. */
  text: optionalText(2000),
};

export const widgetTemplateSchema = z
  .object({
    portableId: portableIdSchema,
    name: text(200),
    description: optionalText(1000),
    ...widgetShape,
  })
  .strict();

export type WidgetTemplateSpec = z.infer<typeof widgetTemplateSchema>;

export const dashboardTemplateSchema = z
  .object({
    portableId: portableIdSchema,
    name: text(200),
    description: optionalText(1000),
    defaultTimeRange: timeRangePresetSchema,
    defaultComparison: comparisonModeSchema.exclude(['custom']),
    widgets: z
      .array(
        z
          .object({
            id: z
              .string()
              .max(64)
              .regex(/^[a-z0-9][a-z0-9-]*$/),
            title: text(200),
            placement: placementSchema,
            ...widgetShape,
          })
          .strict(),
      )
      .min(1)
      .max(SOLUTION_PACKAGE_LIMITS.maxWidgetsPerDashboard),
  })
  .strict();

export type DashboardTemplateSpec = z.infer<typeof dashboardTemplateSchema>;

// --- manifest ------------------------------------------------------------------

export const INCLUDED_OBJECT_TYPES = [
  'semantic_definition',
  'requirement',
  'widget_template',
  'dashboard_template',
  'context_profile',
  'glossary',
] as const;

export const solutionManifestSchema = z
  .object({
    packageId: packageIdSchema,
    packageVersion: packageVersionSchema,
    packageSchemaVersion: z.literal(SOLUTION_PACKAGE_SCHEMA_VERSION),
    name: text(200),
    description: optionalText(2000),
    publisher: text(200),
    createdAt: z.string().datetime({ offset: false }),
    productCompatibility: z
      .object({ min: packageVersionSchema, max: packageVersionSchema.optional() })
      .strict(),
    dependencies: z
      .array(z.object({ packageId: packageIdSchema, minVersion: packageVersionSchema }).strict())
      .max(20),
    requiredCapabilities: z.array(matomoCapabilitySchema).max(20),
    includedObjects: z
      .array(
        z.object({ type: z.enum(INCLUDED_OBJECT_TYPES), portableId: portableIdSchema }).strict(),
      )
      .max(1000),
    /** Where the package came from: a publisher's release, or an export. */
    origin: z.object({ kind: z.enum(['publisher', 'export']), note: optionalText(200) }).strict(),
  })
  .strict();

export type SolutionManifest = z.infer<typeof solutionManifestSchema>;

export const solutionPackageSchema = z
  .object({
    manifest: solutionManifestSchema,
    requirements: z.array(packageRequirementSchema).max(SOLUTION_PACKAGE_LIMITS.maxRequirements),
    definitions: z.array(portableDefinitionSchema).max(SOLUTION_PACKAGE_LIMITS.maxDefinitions),
    widgetTemplates: z.array(widgetTemplateSchema).max(SOLUTION_PACKAGE_LIMITS.maxWidgetTemplates),
    dashboardTemplates: z
      .array(dashboardTemplateSchema)
      .max(SOLUTION_PACKAGE_LIMITS.maxDashboardTemplates),
    contextProfile: contextProfileSchema.optional(),
    glossary: z
      .array(z.object({ term: text(120), definition: text(1000) }).strict())
      .max(200)
      .optional(),
  })
  .strict();

export type SolutionPackage = z.infer<typeof solutionPackageSchema>;

// --- install analysis, as the API reports it ------------------------------------

/** One finding of the analysis, in the order of the install flow (Master Spec §14). */
export const PACKAGE_CHECK_STAGES = [
  'validate',
  'compatibility',
  'dependencies',
  'mapping',
  'conflicts',
] as const;
export type PackageCheckStage = (typeof PACKAGE_CHECK_STAGES)[number];

export interface PackageIssue {
  readonly stage: PackageCheckStage;
  /** `error` blocks the install; `warning` is shown and accepted explicitly. */
  readonly severity: 'error' | 'warning';
  readonly messageKey: string;
  readonly messageParams?: Readonly<Record<string, string | number>>;
  /** Where in the package, e.g. `definitions[3].body.ast`. */
  readonly path?: string;
}

export interface MappingCandidate {
  /** A normalised source metric the target site offers. */
  readonly sourceMetric: string;
  readonly label: string;
}

export interface RequirementMapping {
  readonly requirement: PackageRequirement;
  /** Already mapped in this project: reused, and shown as such. */
  readonly existing?:
    | { readonly sourceMetric: string }
    | { readonly notAvailable: true }
    /** Mapped to something other than a metric (an event, a dimension): kept as is. */
    | { readonly other: string };
  readonly candidates: readonly MappingCandidate[];
}

export const CONFLICT_KINDS = ['identical', 'changed', 'foreign'] as const;

/**
 * A portable id the project already knows.
 *
 * `identical`: the same content - reused, nothing to decide.
 * `changed`: an older or edited version - the installer decides: keep what is
 * there, or add the package's content as a new version. Never overwritten in
 * place; published dashboards keep the version they pinned.
 * `foreign`: the id exists but is not a definition of the same type - the
 * package cannot be installed until that is resolved by hand.
 */
export interface PackageConflict {
  readonly objectType: 'semantic_definition' | 'widget_template' | 'dashboard_template';
  readonly portableId: string;
  readonly kind: (typeof CONFLICT_KINDS)[number];
  readonly name: string;
}

export const CONFLICT_RESOLUTIONS = ['keep_existing', 'new_version'] as const;
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number];

export interface PackageAnalysis {
  /** Null when the package did not validate: an invalid manifest says nothing. */
  readonly manifest: SolutionManifest | null;
  /** No `error` issue anywhere: the package may be installed once mapped. */
  readonly installable: boolean;
  readonly issues: readonly PackageIssue[];
  readonly compatibility: 'supported' | 'supported_with_limitations' | 'unsupported';
  readonly mappings: readonly RequirementMapping[];
  readonly conflicts: readonly PackageConflict[];
  /** What an install would create or reuse, for the preview step. */
  readonly preview: {
    readonly definitionsNew: number;
    readonly definitionsReused: number;
    readonly definitionsConflicting: number;
    readonly widgetTemplates: number;
    readonly dashboardTemplates: number;
  };
  /** The version of this package already installed in the project, if any. */
  readonly installedVersion?: string;
}

export const solutionInstallRequestSchema = z
  .object({
    /** requirement key -> the source metric chosen for it, or "not available". */
    mappings: z.record(
      portableIdSchema,
      z.union([
        z
          .string()
          .max(64)
          .regex(/^[a-z][a-z0-9_]*$/),
        z.literal('not_available'),
      ]),
    ),
    /** portable id -> how a `changed` conflict is resolved. */
    resolutions: z.record(portableIdSchema, z.enum(CONFLICT_RESOLUTIONS)),
    /** The installer has read the warnings and proceeds anyway. */
    acceptWarnings: z.boolean(),
  })
  .strict();

export type SolutionInstallRequest = z.infer<typeof solutionInstallRequestSchema>;

export interface SolutionInstallResult {
  readonly installationId: string;
  readonly packageId: string;
  readonly packageVersion: string;
  readonly definitionsCreated: number;
  readonly definitionsReused: number;
  readonly versionsAdded: number;
  readonly templates: number;
}

// --- templates and installations, as the API lists them -----------------------

export const TEMPLATE_LAYERS = ['global', 'solution', 'tenant', 'project'] as const;
export type TemplateLayer = (typeof TEMPLATE_LAYERS)[number];

export const TEMPLATE_KINDS = ['widget', 'dashboard'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** Ready / Setup Required / Not Fully Supported (Requirements Baseline §15). */
export const TEMPLATE_READINESS = ['ready', 'setup_required', 'not_fully_supported'] as const;
export type TemplateReadiness = (typeof TEMPLATE_READINESS)[number];

export interface TemplateSummary {
  readonly id: string;
  readonly kind: TemplateKind;
  readonly layer: TemplateLayer;
  readonly portableId: string;
  readonly name: string;
  readonly description: string | null;
  readonly version: number;
  /** The solution it came with, when it came with one. */
  readonly solution?: {
    readonly packageId: string;
    readonly name: string;
    readonly version: string;
  };
  readonly readiness: TemplateReadiness;
  /** What is missing when not ready, as requirement or definition names. */
  readonly missing: readonly string[];
  /** For a dashboard template: how many widgets it creates. */
  readonly widgetCount?: number;
  readonly family?: string;
}

export interface SolutionInstallationSummary {
  readonly id: string;
  readonly packageId: string;
  readonly packageVersion: string;
  readonly name: string;
  readonly publisher: string;
  readonly installedAt: string;
  readonly installedBy: string | null;
  readonly current: boolean;
}

/** A package the product offers without an upload (first-party catalogue). */
export interface SolutionCatalogEntry {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly name: string;
  readonly description: string | null;
  readonly publisher: string;
}
