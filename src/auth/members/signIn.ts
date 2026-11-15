/**
 * The pure rules for what a successful provider login does to a member.
 */
import type { MemberSignupPolicy, MemberStatus } from "@tessellatepos/sdk";
import type { MemberDecision } from "@tessellatepos/plugin-sdk/server";

/** What the service should do after the provider vouched for the person. */
export type SignInOutcome =
    /** The plugin refused them (even an existing member). */
    | { kind: "denied"; reason: string }
    /** An existing member that staff disabled. */
    | { kind: "disabled" }
    /** Waiting for approval; no session is issued. `create` adds the row. */
    | { kind: "pending"; create: boolean }
    /** Sign in. `create` adds the row first (open signup). */
    | { kind: "active"; create: boolean };

/**
 * Decides the outcome of a login.
 * @param existing the member's current status, or null for a first login
 * @param decision what the plugin's `resolveMember` returned
 * @param policy the effective signup policy for new members
 * @returns the outcome
 */
export function decideSignIn(
    existing: MemberStatus | null,
    decision: MemberDecision,
    policy: MemberSignupPolicy,
): SignInOutcome {
    if ("deny" in decision) {
        return { kind: "denied", reason: decision.deny };
    }
    if (existing === "disabled") return { kind: "disabled" };
    if (existing === "pending") return { kind: "pending", create: false };
    if (existing === "active") return { kind: "active", create: false };
    return policy === "open"
        ? { kind: "active", create: true }
        : { kind: "pending", create: true };
}
