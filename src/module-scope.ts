import type {
  ModuleContextRoot,
  ResolvedModuleGraph,
  ResolvedModuleNode,
  ResolvedModuleRoleScope,
  ResolvedRoleReference,
} from './host-types.js';

import { compareCodeUnits, equalArrays } from './companion-module.js';

/**
 * Return the single non-role node in `graph` that represents `root` (either
 * `root` itself or a top-level `$ref` attaching to `root` or beneath `root`),
 * or `undefined` when zero or multiple nodes match.
 */
export function findModuleContextRoot(
  graph: ResolvedModuleGraph,
  root: ModuleContextRoot,
): ResolvedModuleNode | undefined {
  let matched: ResolvedModuleNode | undefined;
  for (const node of graph.nodesByDeclaredPath.values()) {
    if (node.ruleSet.$role === true || !isContextRootAttachment(node, root)) {
      continue;
    }
    if (matched !== undefined) {
      return undefined;
    }
    matched = node;
  }
  return matched;
}

/**
 * Find the node in `graph` that represents `root` — either the context root
 * record itself, or the single top-level `$ref` node that attaches directly to
 * `root` or to a descendant record beneath `root`.
 */
export function resolveModuleContextRoot(graph: ResolvedModuleGraph, root: ModuleContextRoot): ResolvedModuleNode {
  const matched = findModuleContextRoot(graph, root);
  if (matched === undefined) {
    throw new TypeError(`Module '${graph.rootModuleUri}' must declare one exact shared root.`);
  }
  return matched;
}

/** Return direct `$role` child paths under `contextPath` that have `read` access to `contextPath`, in authored `$actions` order. */
export function resolveModuleContextRoles(graph: ResolvedModuleGraph, contextPath: string): readonly string[] {
  const contextNode = graph.nodesByDeclaredPath.get(contextPath);
  if (contextNode === undefined || contextNode.ruleSet.$role === true) {
    throw new TypeError(`Context path '${contextPath}' must identify a non-role record.`);
  }
  if (contextNode.kind === 'ref') {
    return [];
  }
  return contextNode.actions
    .filter(action =>
      action.rule.can.includes('read')
      && action.rule.role !== undefined
      && graph.nodesByDeclaredPath.get(action.rule.role)?.kind === 'record'
      && sameModuleAddress(action.resolvedRole?.parentAncestor, contextNode),
    )
    .map(action => action.rule.role!);
}

/** Resolve the context root path and authorized record paths for `role` within `graph`. */
export function resolveModuleRoleScope(graph: ResolvedModuleGraph, role: ResolvedRoleReference): ResolvedModuleRoleScope {
  if (role.parentAncestor === undefined || role.ruleSet.$role !== true) {
    throw new TypeError('A context scope requires a contextual role and its parent context.');
  }
  const contextRootNode = resolveModuleContextRoot(graph, role.parentAncestor);
  const contextPath = contextRootNode.declaringModulePath;
  const allowedPaths: string[] = [];
  const readablePaths: string[] = [];
  const invokedRoles = new Set<string>();
  for (const [path, node] of graph.nodesByDeclaredPath) {
    if (!isRecordUnderContext(graph.rootModuleUri, contextPath, path, node)) {
      continue;
    }
    const access = collectNodeRoleAccess(node, role, invokedRoles);
    if (access.allowed) {
      allowedPaths.push(path);
    }
    if (access.readable) {
      readablePaths.push(path);
    }
  }
  if (contextRootNode.kind === 'record' && !readablePaths.includes(contextPath)) {
    throw new TypeError(`Context role '${role.rawRole}' must authorize reading its parent context '${contextPath}'.`);
  }
  if (readablePaths.length === 0) {
    throw new TypeError(`Module '${graph.rootModuleUri}' has no records readable through the selected context role.`);
  }
  allowedPaths.sort(compareCodeUnits);
  readablePaths.sort(compareCodeUnits);
  return {
    contextPath,
    moduleRole: [...invokedRoles].sort(compareCodeUnits)[0]!,
    allowedPaths: new Set(allowedPaths),
    readablePaths: readablePaths as [string, ...string[]],
  };
}

/** Whether two resolved record nodes have the same wire representation, owning module/path, and ancestor chain. */
export function recordRepresentationsEqual(expected: ResolvedModuleNode, actual: ResolvedModuleNode): boolean {
  if (
    expected.owningModuleUri !== actual.owningModuleUri
    || expected.owningModulePath !== actual.owningModulePath
    || expected.recordType.schema !== actual.recordType.schema
    || (expected.recordType.encryptionRequired === true) !== (actual.recordType.encryptionRequired === true)
    || (expected.ruleSet.$role === true) !== (actual.ruleSet.$role === true)
    || (expected.ruleSet.$squash === true) !== (actual.ruleSet.$squash === true)
    || expected.physicalAncestors.length !== actual.physicalAncestors.length
  ) {
    return false;
  }
  for (let index = 0; index < expected.physicalAncestors.length; index++) {
    if (!sameModuleAddress(expected.physicalAncestors[index], actual.physicalAncestors[index]!)) {
      return false;
    }
  }
  const expectedFormats = normalizeFormats(expected.recordType.dataFormats);
  const actualFormats = normalizeFormats(actual.recordType.dataFormats);
  if (expectedFormats === undefined || actualFormats === undefined) {
    return expectedFormats === actualFormats;
  }
  return equalArrays(expectedFormats, actualFormats);
}

function normalizeFormats(formats: readonly string[] | undefined): readonly string[] | undefined {
  return formats === undefined ? undefined : [...new Set(formats)].sort(compareCodeUnits);
}

function collectNodeRoleAccess(
  node: ResolvedModuleNode,
  role: ResolvedRoleReference,
  invokedRoles: Set<string>,
): { allowed: boolean; readable: boolean } {
  let allowed = false;
  let readable = false;
  for (const action of node.actions) {
    if (!sameModuleAddress(action.resolvedRole, role)) {
      continue;
    }
    allowed = true;
    invokedRoles.add(action.rule.role!);
    if (action.rule.can.includes('read')) {
      readable = true;
    }
  }
  return { allowed, readable };
}

function isRecordUnderContext(moduleUri: string, contextPath: string, path: string, node: ResolvedModuleNode): boolean {
  return node.kind === 'record'
    && node.owningModuleUri === moduleUri
    && node.declaringModuleUri === moduleUri
    && node.ruleSet.$role !== true
    && matchesSubtree(contextPath, path);
}

export function matchesSubtree(prefix: string, candidate: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function isContextRootAttachment(node: ResolvedModuleNode, root: ModuleContextRoot): boolean {
  return sameModuleAddress(node, root)
    || (node.kind === 'ref' && node.physicalAncestors.some(ancestor => sameModuleAddress(ancestor, root)));
}

function sameModuleAddress(left: ModuleContextRoot | undefined, right: ModuleContextRoot): boolean {
  return left?.owningModuleUri === right.owningModuleUri && left.owningModulePath === right.owningModulePath;
}
