/**
 * The container rule -- the third `inspectCapabilityChain` inspector, beside
 * the revocation one (`lib/revocations.ts`) and the client-annex clause
 * (`lib/clientAnnexClause.ts`).
 *
 * An unsafe method at a container URL -- a Space or a Collection -- is
 * controller-only, with two exceptions. The hazard is the prefix one: a data
 * grant's `invocationTarget` IS the container URL, so the zcap library's
 * `/`-boundary target attenuation separates deleting a Resource under a
 * Collection from deleting the Collection itself in no way at all. Under the
 * v0.5 layout the Space Metadata object sits at `/space/<S>/meta` and Delete
 * Space is `DELETE /space/<S>/`, so a Space-subtree grant reaches both by
 * ordinary attenuation. This rule is the route-level answer: it reads the
 * shape of the invoked capability -- the chain's tail -- and is independent of
 * who signed any link, so it holds whatever DID method the controller or any
 * delegator uses.
 *
 * Three rules, spread over five protected operations:
 *
 * - `controller-only` -- only a direct root-capability invocation passes. A
 *   delegated capability is refused whatever its `allowedAction`. Used by
 *   `PUT /space/<S>/meta` on an existing Space and by
 *   `DELETE /space/<S>/<C>/`. It turns on nothing but whether the
 *   `Capability-Invocation` header embeds a delegated capability, so
 *   `handleZcapVerify` decides it from that header before any verification
 *   work; the inspector refuses the same chains as a backstop. The other two
 *   rules read the dereferenced chain's tail.
 * - `exact-delete` -- a direct root invocation, or a delegated capability
 *   whose tail targets exactly the Space's canonical trailing-slash URL with
 *   `allowedAction` exactly `['DELETE']`. A whole-action-set grant carrying
 *   DELETE is a data grant and is refused; a single-verb DELETE grant is not.
 *   Used by `DELETE /space/<S>/`.
 * - `space-subtree-put` -- a direct root invocation, or a delegated capability
 *   whose tail targets exactly the Space's canonical trailing-slash URL (the
 *   shape a wallet's generation delegation carries). The library already
 *   checks that the action covers the invoked verb. A capability targeting the
 *   Collection container URL, the Collection Metadata URL, or a Resource URL
 *   is refused. Used by `PUT /space/<S>/<C>/meta` and by
 *   `PUT /space/<S>/<C>/meta/log`, the guarded create of the Collection's
 *   governing history log (which from then on derives the Collection's served
 *   `encryption` descriptor).
 *
 * The tail alone is read, not every link. A wallet mints a DELETE-only child
 * of a two-verb management parent and invokes the child; that shape stays
 * admitted, and it is the invoked grant that says what the caller may do. The
 * client-annex clause's `ladderInvocationRefusal` reads the ladder-signed
 * links instead, because that bound is a statement about what a ladder
 * verification method signed. The two compose: this rule refuses first (it is
 * the cheapest check, and needs no resolution), and the clause still refuses a
 * ladder-signed chain that this rule would admit.
 *
 * A refusal binds the capability decision only, like every other chain
 * inspection failure. All five protected handlers are capability-only, so a
 * refusal surfaces as the ordinary masked `not-found` denial.
 */
import type { InspectCapabilityChain } from '@interop/zcap'
import { actionsExactly, type ChainCapability } from './chainCapability.js'

/**
 * Which container rule one verification applies.
 */
export type ContainerRule =
  'controller-only' | 'exact-delete' | 'space-subtree-put'

/**
 * Builds the container-rule inspection hook for one verification: the whole
 * decision, for all three rules. A chain of length one is the synthesized
 * root alone -- a direct root invocation -- and always passes. The zcap
 * library runs the hook on that chain too, so the root case needs no separate
 * treatment at the call site. `controller-only` refuses every longer chain;
 * `handleZcapVerify` reaches the same verdict off the invocation header
 * before any verification work, so for that rule this hook is the backstop
 * rather than the deciding check.
 *
 * @param options {object}
 * @param options.rule {ContainerRule}   the rule the invoked operation carries
 * @param options.spaceUrl {string}   the Space's canonical trailing-slash URL
 * @returns {InspectCapabilityChain}
 */
export function containerRuleInspector({
  rule,
  spaceUrl
}: {
  rule: ContainerRule
  spaceUrl: string
}): InspectCapabilityChain {
  return async ({ capabilityChain }) => {
    if (capabilityChain.length <= 1) {
      return { valid: true }
    }
    if (rule === 'controller-only') {
      return {
        valid: false,
        error: new Error(
          'This operation accepts a direct root-capability invocation only; ' +
            'a delegated capability is refused whatever its allowedAction.'
        )
      }
    }
    const tail = capabilityChain[capabilityChain.length - 1] as ChainCapability
    if (rule === 'exact-delete') {
      if (
        tail.invocationTarget === spaceUrl &&
        actionsExactly({ capability: tail, action: 'DELETE' })
      ) {
        return { valid: true }
      }
      return {
        valid: false,
        error: new Error(
          'Delete Space accepts a delegated capability only when the invoked ' +
            "capability's invocationTarget is exactly that Space's canonical " +
            'trailing-slash URL and its allowedAction is exactly ["DELETE"].'
        )
      }
    }
    if (tail.invocationTarget === spaceUrl) {
      return { valid: true }
    }
    return {
      valid: false,
      error: new Error(
        'Update Collection Metadata accepts a delegated capability only when ' +
          "the invoked capability's invocationTarget is exactly the Space's " +
          'canonical trailing-slash URL (its items subtree).'
      )
    }
  }
}
