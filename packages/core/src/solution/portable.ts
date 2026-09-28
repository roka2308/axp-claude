import type {
  FormulaNode,
  PortableDefinitionBody,
  PortableFormulaNode,
  SemanticDefinitionBody,
} from '@axp/contracts';

/**
 * Translation between the portable form of a definition (references by
 * portable id) and the local form (references by pinned version id).
 *
 * Portable id is not local id (Shared Contract §13): the same package installs
 * into any project, and its references are resolved against that project.
 */

/** Portable -> local. Every reference must resolve; a gap is a bug upstream. */
export function toLocalBody(
  body: PortableDefinitionBody,
  versionOf: ReadonlyMap<string, string>,
): SemanticDefinitionBody {
  const resolve = (portableId: string) => {
    const versionId = versionOf.get(portableId);
    if (!versionId) throw new Error(`Unresolved portable reference ${portableId}.`);
    return versionId;
  };

  switch (body.kind) {
    case 'native':
    case 'custom':
      return body;
    case 'formula':
      return { ...body, ast: localNode(body.ast, resolve) };
    case 'score':
      return {
        ...body,
        components: body.components.map(({ portableId, ...component }) => ({
          ...component,
          semanticVersionId: resolve(portableId),
        })),
      };
  }
}

function localNode(node: PortableFormulaNode, resolve: (id: string) => string): FormulaNode {
  switch (node.type) {
    case 'constant':
      return node;
    case 'reference':
      return { type: 'reference', semanticVersionId: resolve(node.portableId) };
    case 'binary':
      return {
        ...node,
        left: localNode(node.left, resolve),
        right: localNode(node.right, resolve),
      };
    case 'function':
      return { ...node, args: node.args.map((arg) => localNode(arg, resolve)) };
  }
}

/**
 * Local -> portable. `null` when a reference points at a version whose
 * definition is unknown here, which the caller reports rather than guesses.
 */
export function toPortableBody(
  body: SemanticDefinitionBody,
  portableOf: ReadonlyMap<string, string>,
): PortableDefinitionBody | null {
  try {
    const resolve = (versionId: string) => {
      const portableId = portableOf.get(versionId);
      if (!portableId) throw new Error('unresolved');
      return portableId;
    };
    switch (body.kind) {
      case 'native':
      case 'custom':
        return body;
      case 'formula':
        return { ...body, ast: portableNode(body.ast, resolve) };
      case 'score':
        return {
          ...body,
          components: body.components.map(({ semanticVersionId, ...component }) => ({
            ...component,
            portableId: resolve(semanticVersionId),
          })),
        } as PortableDefinitionBody;
    }
  } catch {
    return null;
  }
}

function portableNode(node: FormulaNode, resolve: (id: string) => string): PortableFormulaNode {
  switch (node.type) {
    case 'constant':
      return node;
    case 'reference':
      return { type: 'reference', portableId: resolve(node.semanticVersionId) };
    case 'binary':
      return {
        ...node,
        left: portableNode(node.left, resolve),
        right: portableNode(node.right, resolve),
      };
    case 'function':
      return { ...node, args: node.args.map((arg) => portableNode(arg, resolve)) };
  }
}

/** Key-order independent JSON, so "the same content" means the same string. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Semantic-version comparison for `x.y.z`. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
