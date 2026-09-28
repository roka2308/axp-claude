import {
  type PackageIssue,
  type PortableDefinition,
  type PortableFormulaNode,
  SOLUTION_PACKAGE_LIMITS,
  type SolutionPackage,
  solutionPackageSchema,
} from '@axp/contracts';
import { overlaps } from '@axp/contracts';

/**
 * Validation of an untrusted solution package (Master Spec §14, Gate F6).
 *
 * Pure: no database, no network. Runs before anything else looks at a
 * package, in two layers:
 *
 *   1. shape - size ceiling, then the strict schema. Anything the schema does
 *      not name is refused, so there is no field to smuggle code, a URL, a
 *      credential or a customer id through;
 *   2. meaning - the package is internally consistent: unique portable ids,
 *      an honest manifest, references that point somewhere, no cycles,
 *      formulas of bounded size, definitions whose type matches their body,
 *      templates that do not overlap.
 *
 * Every finding is reported, not just the first, so an author fixing a
 * package sees the whole list at once.
 */

export interface PackageValidation {
  readonly package: SolutionPackage | null;
  readonly issues: PackageIssue[];
  /**
   * Portable ids referenced but not defined in the package. Not an error
   * here: they may already exist in the target project, which only the
   * analysis can tell.
   */
  readonly externalReferences: string[];
}

const TYPE_FOR_KIND = {
  native: 'native_metric',
  custom: 'custom_metric',
  formula: 'formula',
  score: 'score',
} as const;

export function validatePackage(input: unknown): PackageValidation {
  const issues: PackageIssue[] = [];
  const fail = (messageKey: string, params?: Record<string, string | number>, path?: string) =>
    issues.push({
      stage: 'validate',
      severity: 'error',
      messageKey,
      ...(params ? { messageParams: params } : {}),
      ...(path ? { path } : {}),
    });

  // --- layer 1: size, then shape ---------------------------------------------
  let raw = input;
  if (typeof input === 'string') {
    if (byteLength(input) > SOLUTION_PACKAGE_LIMITS.maxBytes) {
      fail('solution.too_large', { maxKb: SOLUTION_PACKAGE_LIMITS.maxBytes / 1024 });
      return { package: null, issues, externalReferences: [] };
    }
    try {
      raw = JSON.parse(input);
    } catch {
      fail('solution.not_json');
      return { package: null, issues, externalReferences: [] };
    }
  } else if (byteLength(JSON.stringify(input) ?? '') > SOLUTION_PACKAGE_LIMITS.maxBytes) {
    fail('solution.too_large', { maxKb: SOLUTION_PACKAGE_LIMITS.maxBytes / 1024 });
    return { package: null, issues, externalReferences: [] };
  }

  const parsed = solutionPackageSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 50)) {
      const path = issue.path.join('.');
      if (issue.code === 'unrecognized_keys') {
        fail('solution.unknown_field', { fields: issue.keys.join(', ') }, path);
      } else if (path === 'manifest.packageSchemaVersion') {
        fail('solution.unsupported_schema_version', undefined, path);
      } else {
        fail('solution.invalid_field', { field: path || '(root)' }, path);
      }
    }
    return { package: null, issues, externalReferences: [] };
  }

  // --- layer 2: meaning --------------------------------------------------------
  const pkg = parsed.data;
  const defined = new Map<string, PortableDefinition>();
  pkg.definitions.forEach((definition, index) => {
    if (defined.has(definition.portableId)) {
      fail('solution.duplicate_id', { id: definition.portableId }, `definitions.${index}`);
    }
    defined.set(definition.portableId, definition);
    if (TYPE_FOR_KIND[definition.body.kind] !== definition.type) {
      fail('solution.type_mismatch', { id: definition.portableId }, `definitions.${index}.type`);
    }
  });

  const requirementKeys = new Set<string>();
  pkg.requirements.forEach((requirement, index) => {
    if (requirementKeys.has(requirement.key)) {
      fail('solution.duplicate_id', { id: requirement.key }, `requirements.${index}`);
    }
    requirementKeys.add(requirement.key);
  });

  const externalReferences = new Set<string>();
  const referencesOf = new Map<string, string[]>();

  pkg.definitions.forEach((definition, index) => {
    const path = `definitions.${index}.body`;
    const body = definition.body;
    let references: string[] = [];

    if (body.kind === 'custom' && !requirementKeys.has(body.requirementKey)) {
      fail('solution.undeclared_requirement', { key: body.requirementKey }, path);
    }
    if (body.kind === 'formula') {
      const size = measureFormula(body.ast);
      if (size.depth > SOLUTION_PACKAGE_LIMITS.maxFormulaDepth) {
        fail('solution.formula_too_deep', { id: definition.portableId }, path);
      }
      if (size.nodes > SOLUTION_PACKAGE_LIMITS.maxFormulaNodes) {
        fail('solution.formula_too_large', { id: definition.portableId }, path);
      }
      references = size.references;
    }
    if (body.kind === 'score') {
      references = body.components.map((component) => component.portableId);
      const thresholds = body.evaluation.map((band) => band.atLeast);
      if (
        thresholds.some((value, position) => position > 0 && value <= thresholds[position - 1]!)
      ) {
        fail('solution.bands_not_ascending', { id: definition.portableId }, path);
      }
    }

    if (references.includes(definition.portableId)) {
      fail('solution.cycle', { id: definition.portableId }, path);
    }
    for (const reference of references) {
      if (!defined.has(reference)) externalReferences.add(reference);
    }
    referencesOf.set(definition.portableId, references);
  });

  for (const id of findCycles(referencesOf)) {
    fail('solution.cycle', { id });
  }

  const widgetMetrics = (metrics: readonly string[], path: string) => {
    for (const metric of metrics) {
      if (!defined.has(metric)) externalReferences.add(metric);
    }
    if (new Set(metrics).size !== metrics.length)
      fail('solution.duplicate_metric', undefined, path);
  };

  const templateIds = new Set<string>();
  pkg.widgetTemplates.forEach((template, index) => {
    const key = `widget:${template.portableId}`;
    if (templateIds.has(key)) {
      fail('solution.duplicate_id', { id: template.portableId }, `widgetTemplates.${index}`);
    }
    templateIds.add(key);
    widgetMetrics(template.metrics, `widgetTemplates.${index}.metrics`);
  });

  pkg.dashboardTemplates.forEach((template, index) => {
    const path = `dashboardTemplates.${index}`;
    const key = `dashboard:${template.portableId}`;
    if (templateIds.has(key)) fail('solution.duplicate_id', { id: template.portableId }, path);
    templateIds.add(key);

    const widgetIds = new Set<string>();
    template.widgets.forEach((widget, position) => {
      const widgetPath = `${path}.widgets.${position}`;
      if (widgetIds.has(widget.id)) fail('solution.duplicate_id', { id: widget.id }, widgetPath);
      widgetIds.add(widget.id);
      widgetMetrics(widget.metrics, `${widgetPath}.metrics`);
      if (widget.placement.x + widget.placement.w > 12) {
        fail('solution.outside_grid', { id: widget.id }, `${widgetPath}.placement`);
      }
      template.widgets.slice(0, position).forEach((earlier) => {
        if (overlaps(earlier.placement, widget.placement)) {
          fail('solution.widgets_overlap', { a: earlier.id, b: widget.id }, widgetPath);
        }
      });
    });
  });

  // The manifest names exactly what is inside: a manifest that under- or
  // over-states the content is not trustworthy about anything else.
  const declared = new Set(
    pkg.manifest.includedObjects
      .filter((entry) =>
        ['semantic_definition', 'requirement', 'widget_template', 'dashboard_template'].includes(
          entry.type,
        ),
      )
      .map((entry) => `${entry.type}:${entry.portableId}`),
  );
  const actual = new Set([
    ...pkg.definitions.map((entry) => `semantic_definition:${entry.portableId}`),
    ...pkg.requirements.map((entry) => `requirement:${entry.key}`),
    ...pkg.widgetTemplates.map((entry) => `widget_template:${entry.portableId}`),
    ...pkg.dashboardTemplates.map((entry) => `dashboard_template:${entry.portableId}`),
  ]);
  const undeclared = [...actual].filter((entry) => !declared.has(entry));
  const phantom = [...declared].filter((entry) => !actual.has(entry));
  if (undeclared.length > 0 || phantom.length > 0) {
    fail('solution.manifest_mismatch', {
      objects: [...undeclared, ...phantom].slice(0, 5).join(', '),
    });
  }

  return {
    package: issues.length === 0 ? pkg : null,
    issues,
    externalReferences: [...externalReferences],
  };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function measureFormula(node: PortableFormulaNode): {
  depth: number;
  nodes: number;
  references: string[];
} {
  const references: string[] = [];
  let nodes = 0;

  const walk = (current: PortableFormulaNode, depth: number): number => {
    nodes += 1;
    switch (current.type) {
      case 'constant':
        return depth;
      case 'reference':
        references.push(current.portableId);
        return depth;
      case 'binary':
        return Math.max(walk(current.left, depth + 1), walk(current.right, depth + 1));
      case 'function':
        return Math.max(depth, ...current.args.map((arg) => walk(arg, depth + 1)));
    }
  };

  return { depth: walk(node, 1), nodes, references: [...new Set(references)] };
}

/** Portable ids that sit on a cycle of in-package references. */
function findCycles(references: ReadonlyMap<string, readonly string[]>): string[] {
  const onCycle = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string, trail: string[]) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      trail.slice(trail.indexOf(id)).forEach((member) => onCycle.add(member));
      return;
    }
    state.set(id, 'visiting');
    for (const next of references.get(id) ?? []) {
      if (references.has(next) && next !== id) visit(next, [...trail, id]);
    }
    state.set(id, 'done');
  };

  for (const id of references.keys()) visit(id, []);
  return [...onCycle];
}

/**
 * Definitions in the order they can be installed: every one after the ones
 * it references.
 */
export function installOrder(definitions: readonly PortableDefinition[]): PortableDefinition[] {
  const byId = new Map(definitions.map((definition) => [definition.portableId, definition]));
  const ordered: PortableDefinition[] = [];
  const placed = new Set<string>();

  const place = (definition: PortableDefinition) => {
    if (placed.has(definition.portableId)) return;
    placed.add(definition.portableId);
    for (const reference of portableReferencesOf(definition)) {
      const dependency = byId.get(reference);
      if (dependency) place(dependency);
    }
    ordered.push(definition);
  };

  definitions.forEach(place);
  return ordered;
}

export function portableReferencesOf(definition: PortableDefinition): string[] {
  const body = definition.body;
  if (body.kind === 'formula') return measureFormula(body.ast).references;
  if (body.kind === 'score') return body.components.map((component) => component.portableId);
  return [];
}
