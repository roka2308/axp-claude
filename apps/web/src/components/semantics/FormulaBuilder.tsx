'use client';

import { useTranslations } from 'next-intl';
import type { FormulaNode, SemanticDefinitionRef } from '@axp/contracts';
import { Button, SelectField, TextField } from '@axp/ui';
import styles from './FormulaBuilder.module.css';

export interface FormulaBuilderProps {
  readonly node: FormulaNode;
  readonly onChange: (node: FormulaNode) => void;
  /** Definitions that can be referenced, with their active version id. */
  readonly metrics: readonly SemanticDefinitionRef[];
}

const OPERATORS = ['+', '-', '*', '/'] as const;
const FUNCTIONS = ['MIN', 'MAX', 'AVG', 'ROUND', 'COALESCE'] as const;

/**
 * Visual formula builder (D6).
 *
 * The editor is a tree because the formula is a tree. There is no text field
 * holding an expression anywhere in this component, which is the same reason
 * the stored AST has no string to interpret: a thing that cannot be typed
 * cannot be injected.
 *
 * Every control is a native select, input or button, so the whole builder is
 * keyboard operable without any custom focus handling (D10).
 */
export function FormulaBuilder({ node, onChange, metrics }: FormulaBuilderProps) {
  return (
    <div className={styles.builder}>
      <NodeEditor node={node} onChange={onChange} metrics={metrics} depth={0} />
    </div>
  );
}

function NodeEditor({
  node,
  onChange,
  metrics,
  depth,
}: {
  readonly node: FormulaNode;
  readonly onChange: (node: FormulaNode) => void;
  readonly metrics: readonly SemanticDefinitionRef[];
  readonly depth: number;
}) {
  const t = useTranslations('semantics');

  const usable = metrics.filter((metric) => metric.currentVersionId);
  const firstMetric = usable[0]?.currentVersionId ?? '';

  /** Replaces this node with a fresh one of another kind. */
  function switchKind(kind: FormulaNode['type']) {
    onChange(blankNode(kind, firstMetric));
  }

  return (
    <div className={styles.node} data-depth={Math.min(depth, 4)}>
      <SelectField
        label={t('nodeKind')}
        value={node.type}
        options={[
          { value: 'reference', label: t('kind.reference') },
          { value: 'constant', label: t('kind.constant') },
          { value: 'binary', label: t('kind.binary') },
          { value: 'function', label: t('kind.function') },
        ]}
        onChange={(event) => switchKind(event.target.value as FormulaNode['type'])}
        className={styles.kind}
      />

      {node.type === 'reference' ? (
        <SelectField
          label={t('metric')}
          value={node.semanticVersionId}
          options={usable.map((metric) => ({
            value: metric.currentVersionId!,
            label: metric.name,
          }))}
          onChange={(event) =>
            onChange({ type: 'reference', semanticVersionId: event.target.value })
          }
        />
      ) : null}

      {node.type === 'constant' ? (
        <TextField
          label={t('value')}
          type="number"
          step="any"
          defaultValue={String(node.value)}
          onBlur={(event) => {
            const parsed = Number(event.target.value);
            if (Number.isFinite(parsed)) onChange({ type: 'constant', value: parsed });
          }}
        />
      ) : null}

      {node.type === 'binary' ? (
        <div className={styles.children}>
          <SelectField
            label={t('operator')}
            value={node.op}
            options={OPERATORS.map((op) => ({ value: op, label: `${op}  ${t(`op.${op}`)}` }))}
            onChange={(event) =>
              onChange({ ...node, op: event.target.value as (typeof OPERATORS)[number] })
            }
            className={styles.operator}
          />

          <fieldset className={styles.branch}>
            <legend className={styles.legend}>{t('left')}</legend>
            <NodeEditor
              node={node.left}
              onChange={(left) => onChange({ ...node, left })}
              metrics={metrics}
              depth={depth + 1}
            />
          </fieldset>

          <fieldset className={styles.branch}>
            <legend className={styles.legend}>{t('right')}</legend>
            <NodeEditor
              node={node.right}
              onChange={(right) => onChange({ ...node, right })}
              metrics={metrics}
              depth={depth + 1}
            />
          </fieldset>
        </div>
      ) : null}

      {node.type === 'function' ? (
        <div className={styles.children}>
          <SelectField
            label={t('function')}
            value={node.name}
            options={FUNCTIONS.map((name) => ({
              value: name,
              label: `${name} · ${t(`fn.${name}`)}`,
            }))}
            onChange={(event) =>
              onChange({ ...node, name: event.target.value as (typeof FUNCTIONS)[number] })
            }
            className={styles.operator}
          />

          {node.args.map((arg, index) => (
            <fieldset key={index} className={styles.branch}>
              <legend className={styles.legend}>{t('argument', { index: index + 1 })}</legend>
              <NodeEditor
                node={arg}
                onChange={(next) =>
                  onChange({
                    ...node,
                    args: node.args.map((current, position) =>
                      position === index ? next : current,
                    ),
                  })
                }
                metrics={metrics}
                depth={depth + 1}
              />
              {node.args.length > 1 ? (
                <Button
                  type="button"
                  onClick={() =>
                    onChange({
                      ...node,
                      args: node.args.filter((_current, position) => position !== index),
                    })
                  }
                >
                  {t('removeArgument')}
                </Button>
              ) : null}
            </fieldset>
          ))}

          {node.args.length < 8 ? (
            <Button
              type="button"
              onClick={() =>
                onChange({ ...node, args: [...node.args, blankNode('reference', firstMetric)] })
              }
            >
              {t('addArgument')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A usable starting point for each node kind, never an empty hole. */
export function blankNode(kind: FormulaNode['type'], metricVersionId: string): FormulaNode {
  switch (kind) {
    case 'constant':
      return { type: 'constant', value: 1 };
    case 'reference':
      return { type: 'reference', semanticVersionId: metricVersionId };
    case 'binary':
      return {
        type: 'binary',
        op: '/',
        left: { type: 'reference', semanticVersionId: metricVersionId },
        right: { type: 'reference', semanticVersionId: metricVersionId },
      };
    case 'function':
      return {
        type: 'function',
        name: 'MIN',
        args: [{ type: 'reference', semanticVersionId: metricVersionId }],
      };
  }
}

/**
 * The formula as one readable line.
 *
 * For summaries and the version history, where a tree would be too much. Never
 * parsed back: this is a rendering, not a representation.
 */
export function formulaToText(node: FormulaNode, names: ReadonlyMap<string, string>): string {
  switch (node.type) {
    case 'constant':
      return String(node.value);
    case 'reference':
      return names.get(node.semanticVersionId) ?? '?';
    case 'binary':
      return `(${formulaToText(node.left, names)} ${node.op} ${formulaToText(node.right, names)})`;
    case 'function':
      return `${node.name}(${node.args.map((arg) => formulaToText(arg, names)).join(', ')})`;
  }
}
