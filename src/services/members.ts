/**
 * Members: people who sign in through a plugin's member login rather than as
 * staff. This service owns sign-in (find or create the member, apply the
 * signup policy), sessions, the owner's login settings and staff management.
 * Secrets are encrypted before they reach the database and never returned.
 */
import { randomUUID } from "node:crypto";
import { Logger } from "tslog";
import type {
    Member,
    MemberPage,
    MemberPatch,
    MemberQuery,
    MemberSignupPolicy,
    MemberStatus,
    Principal,
} from "@tessellatepos/sdk";
import type { MemberProfile } from "@tessellatepos/plugin-sdk/server";
import {
    effectiveMemberConfig,
    isMemberSourceActive,
    memberProviders,
    memberScope,
    type MemberSourceConfig,
    type MemberSourceSettings,
    type RegisteredMemberProvider,
} from "@/auth/members/providers";
import { decideSignIn } from "@/auth/members/signIn";
import {
    MEMBER_SESSION_MS,
    hashMemberToken,
    newMemberToken,
} from "@/auth/members/sessions";
import { decrypt, encrypt } from "@/services/crypto";
import { getCustomer } from "@/services/customers";
import {
    deleteMemberRow,
    deleteMemberSession,
    deleteMemberSessions,
    getMemberBySession,
    getMemberByIdentity,
    getMemberRow,
    insertMemberRow,
    insertMemberSession,
    listMemberRows,
    listMemberSourceRows,
    updateMemberRow,
    upsertMemberSourceRow,
} from "@/services/db/members";

const logger = new Logger();

const MAX_NAME = 100;
const MAX_EMAIL = 254;
const STATUSES: readonly MemberStatus[] = ["active", "pending", "disabled"];

/** Where member events go. The owning plugin is the only listener. */
export interface MemberEvents {
    created(member: Member): void;
    updated(member: Member, previous: Member): void;
    deleted(member: Member): void;
}

/** Thrown for input staff or the owner got wrong. */
export class MemberValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MemberValidationError";
    }
}

// ── Owner settings ──

const key = (plugin: string, provider: string) => `${plugin}\u0000${provider}`;

/**
 * Reads the saved settings. A row that cannot be decrypted counts as
 * disabled and unconfigured rather than breaking sign-in for everyone.
 * @returns settings by plugin and provider
 */
export async function loadMemberSources(): Promise<
    Map<string, MemberSourceSettings>
> {
    const out = new Map<string, MemberSourceSettings>();
    for (const row of await listMemberSourceRows()) {
        try {
            out.set(key(row.plugin, row.provider), {
                enabled: row.enabled,
                signup: (row.signup as MemberSignupPolicy | null) ?? null,
                config: JSON.parse(decrypt(row.config)) as MemberSourceConfig,
            });
        } catch {
            logger.error(
                `Could not read the saved settings of member login "${row.plugin}/${row.provider}"; treating it as disabled`,
            );
            out.set(key(row.plugin, row.provider), {
                enabled: false,
                signup: null,
                config: {},
            });
        }
    }
    return out;
}

/** One member login as the owner sees it. Never carries a secret. */
export interface AdminMemberSource {
    plugin: string;
    id: string;
    label: string;
    enabled: boolean;
    configured: boolean;
    signup: MemberSignupPolicy;
    /** Whether the owner overrode the plugin's signup choice. */
    signupOverridden: boolean;
    fields: { clientId?: string; hasSecret: boolean };
}

/** What a PUT may change. An empty or absent `clientSecret` keeps the old one. */
export interface MemberSourcePatch {
    enabled?: boolean;
    signup?: MemberSignupPolicy | null;
    clientId?: string;
    clientSecret?: string;
}

/**
 * @returns every registered member login with the owner's settings applied
 */
export async function listAdminMemberSources(): Promise<AdminMemberSource[]> {
    const settings = await loadMemberSources();
    return memberProviders.list().map(({ pluginName, provider }) => {
        const saved = settings.get(key(pluginName, provider.id));
        const config = effectiveMemberConfig(provider, saved);
        return {
            plugin: pluginName,
            id: provider.id,
            label: provider.label,
            enabled: !!saved?.enabled,
            configured: !!config.clientId && !!config.clientSecret,
            signup: config.signup,
            signupOverridden: !!saved?.signup,
            fields: {
                clientId: config.clientId || undefined,
                hasSecret: !!config.clientSecret,
            },
        };
    });
}

/**
 * Applies a change to one member login and stores it.
 * @param plugin the plugin
 * @param providerId the login's id
 * @param patch what to change
 * @throws MemberValidationError for an unknown login or bad values
 */
export async function saveMemberSource(
    plugin: string,
    providerId: string,
    patch: MemberSourcePatch,
): Promise<void> {
    if (!memberProviders.get(plugin, providerId)) {
        throw new MemberValidationError(
            `No member login "${providerId}" from plugin "${plugin}"`,
        );
    }
    if (
        patch.signup !== undefined &&
        patch.signup !== null &&
        patch.signup !== "open" &&
        patch.signup !== "approval"
    ) {
        throw new MemberValidationError('signup must be "open" or "approval"');
    }
    const current =
        (await loadMemberSources()).get(key(plugin, providerId)) ??
        ({ enabled: false, signup: null, config: {} } as MemberSourceSettings);
    const config: MemberSourceConfig = { ...current.config };
    if (patch.clientId !== undefined) config.clientId = patch.clientId.trim();
    if (patch.clientSecret) config.clientSecret = patch.clientSecret;
    await upsertMemberSourceRow({
        plugin,
        provider: providerId,
        enabled: patch.enabled ?? current.enabled,
        signup: patch.signup === undefined ? current.signup : patch.signup,
        config: encrypt(JSON.stringify(config)),
    });
}

/** A login the member surface may start. */
export interface ActiveMemberSource {
    registered: RegisteredMemberProvider;
    config: ReturnType<typeof effectiveMemberConfig>;
}

/**
 * Looks up a login that is enabled and has credentials.
 * @param plugin the plugin
 * @param providerId the login's id
 * @returns it, or null when unknown, disabled or unconfigured
 */
export async function getActiveMemberSource(
    plugin: string,
    providerId: string,
): Promise<ActiveMemberSource | null> {
    const registered = memberProviders.get(plugin, providerId);
    if (!registered) return null;
    const saved = (await loadMemberSources()).get(key(plugin, providerId));
    const config = effectiveMemberConfig(registered.provider, saved);
    return isMemberSourceActive(config, saved) ? { registered, config } : null;
}

/**
 * The logins of one plugin that are ready, for the login screen.
 * @param plugin the plugin
 * @returns id and label of each
 */
export async function listPublicMemberSources(
    plugin: string,
): Promise<{ id: string; label: string }[]> {
    const settings = await loadMemberSources();
    return memberProviders
        .list(plugin)
        .filter(({ provider }) => {
            const saved = settings.get(key(plugin, provider.id));
            return isMemberSourceActive(
                effectiveMemberConfig(provider, saved),
                saved,
            );
        })
        .map(({ provider }) => ({ id: provider.id, label: provider.label }));
}

// ── Sign-in ──

/** What a finished provider login produced. */
export type SignInResult =
    | { kind: "signed-in"; member: Member; token: string; expiresAt: Date }
    | { kind: "pending"; member: Member }
    | { kind: "disabled" }
    | { kind: "denied"; reason: string };

function clip(value: string | undefined, max: number): string {
    return (value ?? "").trim().slice(0, max);
}

/**
 * Applies the plugin's decision and signup policy to a verified profile and,
 * when allowed, starts a session.
 * @param source the active login
 * @param profile the provider's verified profile
 * @param events where member events go
 * @returns what happened
 */
export async function completeMemberSignIn(
    source: ActiveMemberSource,
    profile: MemberProfile,
    events: MemberEvents,
): Promise<SignInResult> {
    const { pluginName, provider } = source.registered;
    let decision;
    try {
        decision = provider.resolveMember
            ? await provider.resolveMember(profile)
            : {};
    } catch (err) {
        // A throwing plugin must never let someone in.
        logger.error(
            `Member login "${pluginName}/${provider.id}" resolveMember threw:`,
            err,
        );
        return { kind: "denied", reason: "The login could not be completed" };
    }

    const existing = await getMemberByIdentity(
        pluginName,
        provider.id,
        profile.subject,
    );
    const outcome = decideSignIn(
        existing?.status ?? null,
        decision,
        source.config.signup,
    );
    if (outcome.kind === "denied") return outcome;
    if (outcome.kind === "disabled") return outcome;

    const chosen = "deny" in decision ? {} : decision;
    const displayName =
        clip(
            chosen.display_name ?? profile.name ?? profile.username,
            MAX_NAME,
        ) || "Member";
    const email = clip(chosen.email ?? profile.email, MAX_EMAIL);

    let member = existing;
    if (!member) {
        const status: MemberStatus =
            outcome.kind === "active" ? "active" : "pending";
        member = await insertMemberRow({
            id: randomUUID(),
            plugin: pluginName,
            provider: provider.id,
            external_id: profile.subject,
            display_name: displayName,
            email,
            status,
        });
        if (member) {
            events.created(member);
        } else {
            // Lost a race with a concurrent first login: use that row.
            member = await getMemberByIdentity(
                pluginName,
                provider.id,
                profile.subject,
            );
            if (!member) throw new Error("Member row vanished");
        }
    }

    // Re-decide against the row we actually hold (it may have won the race).
    if (member.status === "disabled") return { kind: "disabled" };
    if (member.status === "pending") return { kind: "pending", member };

    const refreshed = await updateMemberRow(member.id, {
        last_login_at: new Date(),
        ...(email && email !== member.email ? { email } : {}),
    });
    member = refreshed ?? member;

    const token = newMemberToken();
    const expiresAt = new Date(Date.now() + MEMBER_SESSION_MS);
    await insertMemberSession(hashMemberToken(token), member.id, expiresAt);
    return { kind: "signed-in", member, token, expiresAt };
}

// ── Sessions ──

/**
 * Resolves a session token to the member principal for one plugin's routes.
 * A member of another plugin, a pending or a disabled member resolves to null.
 * @param token the session token
 * @param plugin the plugin whose member surface was called
 * @returns the principal, or null
 */
export async function resolveMemberPrincipal(
    token: string,
    plugin: string,
): Promise<Principal | null> {
    const member = await getMemberBySession(hashMemberToken(token));
    if (!member || member.status !== "active" || member.plugin !== plugin) {
        return null;
    }
    return {
        kind: "member",
        id: member.id,
        display_name: member.display_name,
        roles: [],
        scopes: [memberScope(member.plugin)],
        location_ids: [],
        plugin: member.plugin,
    };
}

/**
 * Ends one session (sign out).
 * @param token the session token
 */
export async function endMemberSession(token: string): Promise<void> {
    await deleteMemberSession(hashMemberToken(token));
}

// ── Staff management ──

/**
 * @param query filters and paging
 * @returns a page of members
 */
export async function listMembers(query: MemberQuery): Promise<MemberPage> {
    return listMemberRows(query);
}

/**
 * @param id the member id
 * @returns the member, or null
 */
export async function getMember(id: string): Promise<Member | null> {
    return getMemberRow(id);
}

/**
 * Validates what staff may change on a member.
 * @param raw the unvalidated body
 * @returns the clean patch
 * @throws MemberValidationError listing the problem
 */
export function validateMemberPatch(raw: unknown): MemberPatch {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new MemberValidationError("body must be an object");
    }
    const body = raw as Record<string, unknown>;
    const patch: MemberPatch = {};
    if (body.display_name !== undefined) {
        if (
            typeof body.display_name !== "string" ||
            body.display_name.trim() === "" ||
            body.display_name.trim().length > MAX_NAME
        ) {
            throw new MemberValidationError(
                `display_name must be 1 to ${MAX_NAME} characters`,
            );
        }
        patch.display_name = body.display_name.trim();
    }
    if (body.status !== undefined) {
        if (!STATUSES.includes(body.status as MemberStatus)) {
            throw new MemberValidationError(
                "status must be active, pending or disabled",
            );
        }
        patch.status = body.status as MemberStatus;
    }
    if (body.customer_id !== undefined) {
        if (
            body.customer_id !== null &&
            (typeof body.customer_id !== "string" || body.customer_id === "")
        ) {
            throw new MemberValidationError(
                "customer_id must be a customer id or null",
            );
        }
        patch.customer_id = body.customer_id as string | null;
    }
    return patch;
}

/**
 * Applies a staff change. Leaving "active" ends the member's sessions.
 * @param id the member id
 * @param patch the validated change
 * @param events where member events go
 * @returns the updated member, or null when it does not exist
 * @throws MemberValidationError when the linked customer does not exist
 */
export async function updateMember(
    id: string,
    patch: MemberPatch,
    events: MemberEvents,
): Promise<Member | null> {
    const previous = await getMemberRow(id);
    if (!previous) return null;
    if (patch.customer_id) {
        if (!(await getCustomer(patch.customer_id))) {
            throw new MemberValidationError("customer_id does not exist");
        }
    }
    const updated = await updateMemberRow(id, patch);
    if (!updated) return null;
    if (patch.status && patch.status !== "active") {
        await deleteMemberSessions(id);
    }
    if (patch.status && patch.status !== previous.status) {
        events.updated(updated, previous);
    }
    return updated;
}

/**
 * Deletes a member and everything the host holds about them.
 * @param id the member id
 * @param events where member events go
 * @returns whether the member existed
 */
export async function removeMember(
    id: string,
    events: MemberEvents,
): Promise<boolean> {
    const member = await getMemberRow(id);
    if (!member) return false;
    const removed = await deleteMemberRow(id);
    if (removed) events.deleted(member);
    return removed;
}

/**
 * Everything the host holds about one member, for a data request.
 * @param id the member id
 * @returns the member record (sessions are secrets and not exported), or null
 */
export async function exportMember(
    id: string,
): Promise<{ member: Member } | null> {
    const member = await getMemberRow(id);
    return member ? { member } : null;
}
