/**
 * The shape of a capability as the chain inspectors see it, plus the
 * `allowedAction` predicates they share. The zcap library hands an
 * `inspectCapabilityChain` hook the dereferenced chain as plain objects;
 * the client-annex clause (`lib/clientAnnexClause.ts`) and the container rule
 * (`lib/containerRule.ts`) both read a link's `allowedAction` the same way, so
 * the predicates live here rather than in either.
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
  const { allowedAction } = capability
  if (allowedAction === undefined) {
    return false
  }
  const actions = Array.isArray(allowedAction) ? allowedAction : [allowedAction]
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
  const { allowedAction } = capability
  if (allowedAction === undefined) {
    return false
  }
  const actions = Array.isArray(allowedAction) ? allowedAction : [allowedAction]
  return actions.length === 1 && actions[0] === action
}
