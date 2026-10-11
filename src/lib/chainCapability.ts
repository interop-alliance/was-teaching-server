/**
 * The shape of a capability as the chain inspectors see it, plus the
 * `allowedAction` predicates they share. The zcap library hands an
 * `inspectCapabilityChain` hook the dereferenced chain as plain objects;
 * the client-annex clause (`lib/clientAnnexClause.ts`) and the container rule
 * (`lib/containerRule.ts`) both read a link's `allowedAction` the same way, so
 * the predicates live here rather than in either, beside the `controller`
 * reader the inspectors and the verifier share.
 */

/**
 * A capability as it appears in a dereferenced chain, reduced to the members
 * the chain inspectors read.
 */
export interface ChainCapability {
  controller?: string | string[]
  invocationTarget?: string
  allowedAction?: string | string[]
}

/**
 * A member that may be a single value or an array (a capability's
 * `controller` or `allowedAction`, a service entry's `type`), as an array. An
 * absent member is the empty array.
 * @param value {T | T[] | undefined}
 * @returns {T[]}
 */
export function asList<T>(value?: T | T[]): T[] {
  if (value === undefined) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

/**
 * Extracts the controller DIDs of one capability (`controller` may be a
 * single value or an array on a synthesized root).
 * @param capability {object}   a capability from a dereferenced chain
 * @returns {string[]}
 */
export function capabilityControllers(capability: {
  controller?: string | string[]
}): string[] {
  return asList(capability.controller)
}

/**
 * Whether a delegation's `allowedAction` stays within an allowlist: present,
 * non-empty, and every member allowed. An absent `allowedAction` permits any
 * action in the zcap model, so it never satisfies a finite allowlist.
 * @param options {object}
 * @param options.capability {object}   the dereferenced capability
 * @param options.allowed {string[]}   the permitted actions
 * @returns {boolean}
 */
export function actionsWithin({
  capability,
  allowed
}: {
  capability: ChainCapability
  allowed: string[]
}): boolean {
  if (capability.allowedAction === undefined) {
    return false
  }
  const actions = asList(capability.allowedAction)
  return actions.length > 0 && actions.every(action => allowed.includes(action))
}

/**
 * Whether a delegation's `allowedAction` is exactly one named action: present,
 * and a single-member set holding it. Stricter than {@link actionsWithin},
 * which admits any subset of its allowlist -- a single-verb predicate must
 * refuse a two-verb grant that happens to contain the verb.
 * @param options {object}
 * @param options.capability {object}   the dereferenced capability
 * @param options.action {string}   the one permitted action
 * @returns {boolean}
 */
export function actionsExactly({
  capability,
  action
}: {
  capability: ChainCapability
  action: string
}): boolean {
  if (capability.allowedAction === undefined) {
    return false
  }
  const actions = asList(capability.allowedAction)
  return actions.length === 1 && actions[0] === action
}
