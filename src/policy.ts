/**
 * Access-control policy evaluation: resolves the effective policy for a target
 * (most-specific level wins) and decides whether a policy grants an action.
 * Policies are the fallback authorization path -- consulted when a capability
 * invocation is absent or does not grant access (see authorize.ts). v1
 * recognizes only `{ "type": "PublicCanRead" }`; any other `type` grants nothing
 * (fail-closed). Also builds the RFC9264 linkset that advertises a Space's or
 * Collection's policy resource for discovery.
 */
import type { PolicyDocument, StorageBackend } from './types.js'

/** The kind of access a request needs; derived from the HTTP method. */
export type AccessAction = 'read' | 'write'

/** Linkset relation URI for the access-control policy auxiliary resource. */
export const POLICY_LINK_RELATION = 'https://wallet.storage/spec#policy'

/**
 * Resolves the policy that governs a target, honoring the spec's
 * most-specific-wins inheritance: a Resource policy overrides a Collection
 * policy, which overrides a Space policy. The first level that has a policy
 * document is the effective policy; if none do, resolves undefined.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}
 * @param [options.resourceId] {string}
 * @returns {Promise<PolicyDocument | undefined>}
 */
export async function resolveEffectivePolicy({
  storage,
  spaceId,
  collectionId,
  resourceId
}: {
  storage: StorageBackend
  spaceId: string
  collectionId?: string
  resourceId?: string
}): Promise<PolicyDocument | undefined> {
  if (collectionId !== undefined && resourceId !== undefined) {
    const resourcePolicy = await storage.getPolicy({
      spaceId,
      collectionId,
      resourceId
    })
    if (resourcePolicy) {
      return resourcePolicy
    }
  }
  if (collectionId !== undefined) {
    const collectionPolicy = await storage.getPolicy({ spaceId, collectionId })
    if (collectionPolicy) {
      return collectionPolicy
    }
  }
  return await storage.getPolicy({ spaceId })
}

/**
 * Decides whether a policy document grants the requested action. Dispatches on
 * the policy `type`; an absent policy or an unrecognized `type` grants nothing
 * (fail-closed).
 *
 * @param options {object}
 * @param [options.policy] {PolicyDocument}   the effective policy, if any
 * @param options.action {AccessAction}
 * @returns {boolean}
 */
export function policyGrants({
  policy,
  action
}: {
  policy?: PolicyDocument
  action: AccessAction
}): boolean {
  if (!policy) {
    return false
  }
  switch (policy.type) {
    case 'PublicCanRead':
      return action === 'read'
    default:
      // Unknown policy type: grant nothing, fall through to zcap-only decision.
      return false
  }
}

/**
 * Builds the RFC9264 linkset for a Space or Collection, advertising its
 * access-control `policy` resource (relation `POLICY_LINK_RELATION`) when a
 * policy document is set at that exact level. Collection vs Space is selected by
 * whether `collectionId` is present.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}
 * @returns {Promise<object>} a `{ linkset: [...] }` object
 */
export async function buildPolicyLinkset({
  storage,
  spaceId,
  collectionId
}: {
  storage: StorageBackend
  spaceId: string
  collectionId?: string
}): Promise<{ linkset: Array<Record<string, unknown>> }> {
  const anchor =
    collectionId !== undefined
      ? `/space/${spaceId}/${collectionId}`
      : `/space/${spaceId}`
  const policyHref = `${anchor}/policy`
  const policy =
    collectionId !== undefined
      ? await storage.getPolicy({ spaceId, collectionId })
      : await storage.getPolicy({ spaceId })

  const entry: Record<string, unknown> = { anchor }
  if (policy) {
    entry[POLICY_LINK_RELATION] = [
      { href: policyHref, type: 'application/json' }
    ]
  }
  return { linkset: [entry] }
}
