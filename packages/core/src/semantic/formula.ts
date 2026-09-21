import {
  AppError,
  type FormulaNode,
  hasNumericValue,
  type SemanticDefinitionBody,
  type SemanticScope,
  type SemanticUnit,
  valueEnvelope,
  type ValueEnvelope,
} from '@axp/contracts';

/**
 * Formula evaluation and validation (Master Spec §13, Shared Contract §7).
 *
 * The whole point of this file is what it does not contain: there is no
 * parser, no `eval`, no template string, no regex over user input. A formula
 * is a tree that was built by clicking, stored as a tree, and walked here.
 * There is nothing to escape because there is nothing to interpret.
 *
 * Two jobs:
 *
 *   - **validate** a formula before it can be activated: units and scopes must
 *     combine meaningfully, references must exist, and the dependency graph
 *     must be acyclic;
 *   - **evaluate** it over resolved inputs, producing a value *and* a trace,
 *     because a number nobody can take apart is a number nobody will trust.
 *
 * Missing inputs are never treated as zero. A formula whose input is missing
 * is `not_calculable` and says which input was missing (D10, §13).
 */

// --- the unit and scope algebra --------------------------------------------

/**
 * What a node produces. `null` means dimensionless or scope-free - a constant
 * belongs to no unit and no scope, which is what makes `visits * 0.5` legal
 * and `visits + seconds` not.
 */
export interface FormulaType {
  readonly unit: SemanticUnit | null;
  readonly scope: SemanticScope | null;
}

export interface FormulaIssue {
  readonly messageKey: string;
  readonly messageParams?: Readonly<Record<string, string | number>>;
}

export interface ValidationContext {
  /** Resolved bodies of everything the formula may reference, by version id. */
  readonly inputs: ReadonlyMap<string, SemanticDefinitionBody>;
  /** Dependencies of each referenced version, for the cycle check. */
  readonly dependencies?: ReadonlyMap<string, readonly string[]>;
  /**
   * Every version of the definition being edited.
   *
   * A cycle is a definition reaching *itself*, and a definition is a set of
   * versions - so referencing version 1 of the thing you are writing version 2
   * of is the cycle, even though the two ids differ.
   */
  readonly selfVersionIds?: readonly string[];
}

export interface ValidationResult {
  readonly issues: readonly FormulaIssue[];
  /** The type the formula produces, when it is valid. */
  readonly type?: FormulaType;
  readonly referencedVersionIds: readonly string[];
}

/**
 * Checks a formula before it may be activated.
 *
 * Returns issues rather than throwing: the builder shows all of them at once,
 * and a half-built formula in a draft is a normal state rather than an error.
 */
export function validateFormula(node: FormulaNode, context: ValidationContext): ValidationResult {
  const issues: FormulaIssue[] = [];
  const referenced = new Set<string>();

  const type = typeOf(node, context, issues, referenced);

  // A cycle is checked over the reference graph rather than the tree: the
  // formula itself is a tree by construction, but `a -> b -> a` is not.
  const self = new Set(context.selfVersionIds ?? []);
  if (context.dependencies && self.size > 0) {
    for (const id of referenced) {
      if (reaches(id, self, context.dependencies)) {
        issues.push({ messageKey: 'semantic.formula.cycle', messageParams: { versionId: id } });
        break;
      }
    }
  }

  return {
    issues,
    ...(issues.length === 0 && type ? { type } : {}),
    referencedVersionIds: [...referenced],
  };
}

/** Whether `from` reaches any of `targets` through the dependency graph. */
function reaches(
  from: string,
  targets: ReadonlySet<string>,
  dependencies: ReadonlyMap<string, readonly string[]>,
): boolean {
  const seen = new Set<string>();
  const queue = [from];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (targets.has(current)) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(dependencies.get(current) ?? []));
  }
  return false;
}

function typeOf(
  node: FormulaNode,
  context: ValidationContext,
  issues: FormulaIssue[],
  referenced: Set<string>,
): FormulaType | null {
  switch (node.type) {
    case 'constant':
      // Dimensionless and scope-free: a number is a number.
      return { unit: null, scope: null };

    case 'reference': {
      referenced.add(node.semanticVersionId);
      const body = context.inputs.get(node.semanticVersionId);
      if (!body) {
        issues.push({
          messageKey: 'semantic.formula.unknown_reference',
          messageParams: { versionId: node.semanticVersionId },
        });
        return null;
      }
      return { unit: body.unit, scope: body.scope };
    }

    case 'binary': {
      const left = typeOf(node.left, context, issues, referenced);
      const right = typeOf(node.right, context, issues, referenced);
      if (!left || !right) return null;

      const scope = combineScopesFor(node.op, left, right, issues);
      const unit = combineUnits(node.op, left, right, issues);
      return unit === undefined ? null : { unit, scope };
    }

    case 'function': {
      const args = node.args.map((arg) => typeOf(arg, context, issues, referenced));
      if (args.some((arg) => arg === null)) return null;
      const types = args as FormulaType[];

      if (types.length === 0) {
        issues.push({
          messageKey: 'semantic.formula.function_needs_arguments',
          messageParams: { name: node.name },
        });
        return null;
      }

      if (node.name === 'ROUND') {
        // ROUND(value, digits): the second argument is a plain number of
        // decimal places, not a measurement.
        if (types.length !== 2 || node.args[1]?.type !== 'constant') {
          issues.push({ messageKey: 'semantic.formula.round_needs_constant_digits' });
          return null;
        }
        return types[0]!;
      }

      // MIN / MAX / AVG / COALESCE all compare or choose between values, which
      // only means something when they are the same kind of thing.
      return types.reduce<FormulaType | null>((accumulated, current) => {
        if (!accumulated) return null;
        const scope = combineScopes(accumulated, current, issues);
        if (!sameUnit(accumulated, current)) {
          issues.push({
            messageKey: 'semantic.formula.unit_mismatch',
            messageParams: {
              left: accumulated.unit ?? 'number',
              right: current.unit ?? 'number',
            },
          });
          return null;
        }
        return { unit: accumulated.unit ?? current.unit, scope };
      }, types[0]!);
    }
  }
}

function sameUnit(a: FormulaType, b: FormulaType): boolean {
  return a.unit === null || b.unit === null || a.unit === b.unit;
}

/**
 * Scope rules, which differ by operation.
 *
 * Adding requires the same scope - visits and actions are counted over
 * different things, so their sum has no referent. Division deliberately does
 * not: `actions / visits` is how "pages per visit" exists at all, and the
 * result is read *per* the denominator (Master Spec §13).
 */
function combineScopesFor(
  op: '+' | '-' | '*' | '/',
  a: FormulaType,
  b: FormulaType,
  issues: FormulaIssue[],
): SemanticScope | null {
  if (op === '/') {
    // "a per b": the denominator names what the result is counted over.
    return b.scope ?? a.scope;
  }
  return combineScopes(a, b, issues);
}

function combineScopes(
  a: FormulaType,
  b: FormulaType,
  issues: FormulaIssue[],
): SemanticScope | null {
  if (a.scope === null) return b.scope;
  if (b.scope === null) return a.scope;
  if (a.scope === b.scope) return a.scope;

  issues.push({
    messageKey: 'semantic.formula.scope_mismatch',
    messageParams: { left: a.scope, right: b.scope },
  });
  return null;
}

/**
 * The unit algebra.
 *
 * Deliberately small. Compound units (`count / second`) are not in the MVP, so
 * anything that would create one is refused rather than silently labelled.
 * `undefined` means "invalid"; `null` means "dimensionless".
 */
function combineUnits(
  op: '+' | '-' | '*' | '/',
  a: FormulaType,
  b: FormulaType,
  issues: FormulaIssue[],
): SemanticUnit | null | undefined {
  const mismatch = () => {
    issues.push({
      messageKey: 'semantic.formula.unit_mismatch',
      messageParams: { left: a.unit ?? 'number', right: b.unit ?? 'number' },
    });
    return undefined;
  };

  switch (op) {
    case '+':
    case '-':
      // Adding requires the same unit. A dimensionless operand adopts the other
      // one, which is how `visits + 10` stays meaningful.
      return sameUnit(a, b) ? (a.unit ?? b.unit) : mismatch();

    case '*': {
      // Scaling is fine; multiplying two measurements is not.
      const dimensionless = (type: FormulaType) => type.unit === null || type.unit === 'ratio';
      if (dimensionless(a)) return b.unit;
      if (dimensionless(b)) return a.unit;
      return mismatch();
    }

    case '/': {
      if (b.unit === null || b.unit === 'ratio') return a.unit;
      // Same unit over same unit cancels into a ratio - the useful case.
      if (a.unit === b.unit) return 'ratio';
      return mismatch();
    }
  }
}

// --- evaluation ------------------------------------------------------------

export interface TraceEntry {
  /** Human-readable description of the step, e.g. `Besuche` or `a / b`. */
  readonly label: string;
  readonly value: ValueEnvelope;
}

export interface FormulaResult {
  readonly value: ValueEnvelope;
  /** How the number came about, in evaluation order. */
  readonly trace: readonly TraceEntry[];
}

export interface EvaluationContext {
  /** Values of the referenced versions, already resolved. */
  readonly values: ReadonlyMap<string, ValueEnvelope>;
  /** Display names, for the trace. */
  readonly names: ReadonlyMap<string, string>;
}

/**
 * Evaluates a formula over resolved inputs.
 *
 * Absence propagates: if an input is missing, the result is `not_calculable`
 * and names the input. `COALESCE` is the only way past that, and it is
 * explicit in the formula rather than a silent default - which is the whole
 * difference between "we chose a fallback" and "we pretended it was zero".
 */
export function evaluateFormula(node: FormulaNode, context: EvaluationContext): FormulaResult {
  const trace: TraceEntry[] = [];
  const value = walk(node, context, trace);
  return { value, trace };
}

function walk(node: FormulaNode, context: EvaluationContext, trace: TraceEntry[]): ValueEnvelope {
  switch (node.type) {
    case 'constant':
      return valueEnvelope.measured(node.value);

    case 'reference': {
      const value = context.values.get(node.semanticVersionId);
      const name = context.names.get(node.semanticVersionId) ?? node.semanticVersionId;
      const resolved = value ?? valueEnvelope.notCalculable([name]);
      trace.push({ label: name, value: resolved });
      return resolved;
    }

    case 'binary': {
      const left = walk(node.left, context, trace);
      const right = walk(node.right, context, trace);

      const absent = firstAbsence([left, right]);
      if (absent) return absent;
      if (!hasNumericValue(left) || !hasNumericValue(right)) return absent ?? left;

      if (node.op === '/' && right.value === 0) {
        // Not an error and not zero: the quotient genuinely does not exist.
        const value = valueEnvelope.missing({
          kind: 'other',
          messageKey: 'semantic.formula.division_by_zero',
        });
        trace.push({ label: '÷ 0', value });
        return value;
      }

      const computed = apply(node.op, left.value, right.value);
      const value = valueEnvelope.measured(computed);
      trace.push({ label: `${left.value} ${node.op} ${right.value}`, value });
      return value;
    }

    case 'function':
      return applyFunction(node, context, trace);
  }
}

function applyFunction(
  node: Extract<FormulaNode, { type: 'function' }>,
  context: EvaluationContext,
  trace: TraceEntry[],
): ValueEnvelope {
  // COALESCE decides what to do about absence, so it must see the raw results
  // rather than being short-circuited by the absence rule.
  if (node.name === 'COALESCE') {
    const tried: string[] = [];
    for (const arg of node.args) {
      const candidate = walk(arg, context, trace);
      if (hasNumericValue(candidate)) {
        trace.push({ label: 'COALESCE', value: candidate });
        return candidate;
      }
      tried.push(describe(arg, context));
    }
    const value = valueEnvelope.notCalculable(tried);
    trace.push({ label: 'COALESCE', value });
    return value;
  }

  const args = node.args.map((arg) => walk(arg, context, trace));
  const absent = firstAbsence(args);
  if (absent) return absent;

  const numbers = args.filter(hasNumericValue).map((entry) => entry.value);

  const computed = (() => {
    switch (node.name) {
      case 'MIN':
        return Math.min(...numbers);
      case 'MAX':
        return Math.max(...numbers);
      case 'AVG':
        return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
      case 'ROUND': {
        const factor = 10 ** (numbers[1] ?? 0);
        return Math.round(numbers[0]! * factor) / factor;
      }
    }
  })();

  const value = valueEnvelope.measured(computed);
  trace.push({ label: node.name, value });
  return value;
}

/**
 * The first absent input, turned into a result for the whole expression.
 *
 * This is where "never coerce a gap to zero" is actually enforced: one missing
 * operand makes the expression not calculable, and carries the reason forward.
 */
function firstAbsence(values: readonly ValueEnvelope[]): ValueEnvelope | null {
  const absent = values.find((value) => !hasNumericValue(value));
  if (!absent) return null;

  if (absent.state === 'missing') return absent;
  if (absent.state === 'unavailable') return absent;
  return valueEnvelope.notCalculable([]);
}

function apply(op: '+' | '-' | '*' | '/', left: number, right: number): number {
  switch (op) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      return left / right;
  }
}

function describe(node: FormulaNode, context: EvaluationContext): string {
  if (node.type === 'reference') {
    return context.names.get(node.semanticVersionId) ?? node.semanticVersionId;
  }
  if (node.type === 'constant') return String(node.value);
  return node.type;
}

/** Every version id a formula references, for pinning and impact analysis. */
export function referencedVersionIds(node: FormulaNode): string[] {
  const found = new Set<string>();

  const visit = (current: FormulaNode): void => {
    if (current.type === 'reference') found.add(current.semanticVersionId);
    else if (current.type === 'binary') {
      visit(current.left);
      visit(current.right);
    } else if (current.type === 'function') current.args.forEach(visit);
  };

  visit(node);
  return [...found];
}

/**
 * Refuses a formula that cannot be activated.
 *
 * The builder uses `validateFormula` and shows issues as it goes; this is the
 * gate at the moment of activation, where a broken formula must not pass.
 */
export function assertFormulaValid(node: FormulaNode, context: ValidationContext): void {
  const { issues } = validateFormula(node, context);
  if (issues.length === 0) return;

  throw new AppError('validation_failed', {
    code: 'formula_invalid',
    messageKey: issues[0]!.messageKey,
    ...(issues[0]!.messageParams ? { messageParams: issues[0]!.messageParams } : {}),
    internalMessage: `Formula rejected: ${issues.map((issue) => issue.messageKey).join(', ')}`,
  });
}
