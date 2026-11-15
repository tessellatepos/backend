import { and, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import type {
    Member,
    MemberPage,
    MemberQuery,
    MemberStatus,
} from "@tessellatepos/sdk";
import { drizzleDB } from "@/services/db/postgres";
import {
    memberSessionsTable,
    memberSourcesTable,
    membersTable,
} from "@/services/db/schema";

type MemberRow = typeof membersTable.$inferSelect;
export type MemberInsert = typeof membersTable.$inferInsert;
export type MemberSourceRow = typeof memberSourcesTable.$inferSelect;

export const DEFAULT_MEMBER_PAGE_SIZE = 50;
export const MAX_MEMBER_PAGE_SIZE = 200;

/** Thrown for a cursor that did not come from a previous page. */
export class InvalidMemberCursorError extends Error {
    constructor() {
        super("Invalid cursor");
        this.name = "InvalidMemberCursorError";
    }
}

/**
 * @param row a members row
 * @returns the SDK Member
 */
export function rowToMember(row: MemberRow): Member {
    return {
        id: row.id,
        plugin: row.plugin,
        provider: row.provider,
        external_id: row.external_id,
        display_name: row.display_name,
        email: row.email,
        status: row.status as MemberStatus,
        customer_id: row.customer_id,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
        last_login_at: row.last_login_at?.toISOString() ?? null,
    };
}

/**
 * @param id the member id
 * @returns the member, or null
 */
export async function getMemberRow(id: string): Promise<Member | null> {
    const [row] = await drizzleDB
        .select()
        .from(membersTable)
        .where(eq(membersTable.id, id))
        .limit(1);
    return row ? rowToMember(row) : null;
}

/**
 * @param plugin the plugin
 * @param provider the plugin's login id
 * @param externalId the person's id at the provider
 * @returns the member, or null
 */
export async function getMemberByIdentity(
    plugin: string,
    provider: string,
    externalId: string,
): Promise<Member | null> {
    const [row] = await drizzleDB
        .select()
        .from(membersTable)
        .where(
            and(
                eq(membersTable.plugin, plugin),
                eq(membersTable.provider, provider),
                eq(membersTable.external_id, externalId),
            ),
        )
        .limit(1);
    return row ? rowToMember(row) : null;
}

/**
 * Inserts a member. A concurrent first login for the same identity loses
 * quietly (the unique index decides) and gets null back.
 * @param row the member to add
 * @returns the new member, or null when the identity already existed
 */
export async function insertMemberRow(
    row: MemberInsert,
): Promise<Member | null> {
    const [created] = await drizzleDB
        .insert(membersTable)
        .values(row)
        .onConflictDoNothing()
        .returning();
    return created ? rowToMember(created) : null;
}

/**
 * @param id the member id
 * @param patch columns to set
 * @returns the updated member, or null when it does not exist
 */
export async function updateMemberRow(
    id: string,
    patch: Partial<MemberInsert>,
): Promise<Member | null> {
    const [row] = await drizzleDB
        .update(membersTable)
        .set({ ...patch, updated_at: new Date() })
        .where(eq(membersTable.id, id))
        .returning();
    return row ? rowToMember(row) : null;
}

/**
 * Deletes a member; its sessions go with it.
 * @param id the member id
 * @returns whether a row was deleted
 */
export async function deleteMemberRow(id: string): Promise<boolean> {
    const rows = await drizzleDB
        .delete(membersTable)
        .where(eq(membersTable.id, id))
        .returning({ id: membersTable.id });
    return rows.length > 0;
}

function encodeCursor(row: MemberRow): string {
    return Buffer.from(
        `${row.created_at.toISOString()}|${row.id}`,
        "utf8",
    ).toString("base64url");
}

function decodeCursor(cursor: string): { at: Date; id: string } {
    const [iso, id] = Buffer.from(cursor, "base64url")
        .toString("utf8")
        .split("|");
    const at = new Date(iso);
    if (!iso || !id || Number.isNaN(at.getTime())) {
        throw new InvalidMemberCursorError();
    }
    return { at, id };
}

/**
 * Lists members, newest first.
 * @param query filters and paging
 * @returns a page
 * @throws InvalidMemberCursorError for a bad cursor
 */
export async function listMemberRows(query: MemberQuery): Promise<MemberPage> {
    const limit = Math.min(
        Math.max(query.limit ?? DEFAULT_MEMBER_PAGE_SIZE, 1),
        MAX_MEMBER_PAGE_SIZE,
    );
    const where: SQL[] = [];
    if (query.plugin) where.push(eq(membersTable.plugin, query.plugin));
    if (query.status) where.push(eq(membersTable.status, query.status));
    if (query.text) {
        const like = `%${query.text.replace(/[\\%_]/g, "\\$&")}%`;
        const match = or(
            sql`${membersTable.display_name} ILIKE ${like}`,
            sql`${membersTable.email} ILIKE ${like}`,
        );
        if (match) where.push(match);
    }
    if (query.cursor) {
        const { at, id } = decodeCursor(query.cursor);
        const before = or(
            lt(membersTable.created_at, at),
            and(eq(membersTable.created_at, at), lt(membersTable.id, id)),
        );
        if (before) where.push(before);
    }
    const rows = await drizzleDB
        .select()
        .from(membersTable)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(membersTable.created_at), desc(membersTable.id))
        .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
        members: page.map(rowToMember),
        next_cursor:
            rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
}

/**
 * Stores a session for a member.
 * @param tokenHash SHA-256 of the token
 * @param memberId the member
 * @param expiresAt when it stops working
 */
export async function insertMemberSession(
    tokenHash: string,
    memberId: string,
    expiresAt: Date,
): Promise<void> {
    await drizzleDB.insert(memberSessionsTable).values({
        token_hash: tokenHash,
        member_id: memberId,
        expires_at: expiresAt,
    });
}

/**
 * Finds the member a live session belongs to.
 * @param tokenHash SHA-256 of the presented token
 * @returns the member, or null for an unknown or expired session
 */
export async function getMemberBySession(
    tokenHash: string,
): Promise<Member | null> {
    const [row] = await drizzleDB
        .select({ member: membersTable })
        .from(memberSessionsTable)
        .innerJoin(
            membersTable,
            eq(memberSessionsTable.member_id, membersTable.id),
        )
        .where(
            and(
                eq(memberSessionsTable.token_hash, tokenHash),
                sql`${memberSessionsTable.expires_at} > now()`,
            ),
        )
        .limit(1);
    return row ? rowToMember(row.member) : null;
}

/**
 * @param tokenHash SHA-256 of the token to end
 */
export async function deleteMemberSession(tokenHash: string): Promise<void> {
    await drizzleDB
        .delete(memberSessionsTable)
        .where(eq(memberSessionsTable.token_hash, tokenHash));
}

/**
 * Ends every session of a member (disable, delete, "sign out everywhere").
 * @param memberId the member
 */
export async function deleteMemberSessions(memberId: string): Promise<void> {
    await drizzleDB
        .delete(memberSessionsTable)
        .where(eq(memberSessionsTable.member_id, memberId));
}

/**
 * Removes expired sessions.
 * @returns how many were removed
 */
export async function purgeExpiredMemberSessions(): Promise<number> {
    const rows = await drizzleDB
        .delete(memberSessionsTable)
        .where(sql`${memberSessionsTable.expires_at} <= now()`)
        .returning({ hash: memberSessionsTable.token_hash });
    return rows.length;
}

/** @returns every saved member login setting */
export async function listMemberSourceRows(): Promise<MemberSourceRow[]> {
    return drizzleDB.select().from(memberSourcesTable);
}

/**
 * @param row the full row, with `config` already encrypted
 */
export async function upsertMemberSourceRow(
    row: typeof memberSourcesTable.$inferInsert,
): Promise<void> {
    await drizzleDB
        .insert(memberSourcesTable)
        .values(row)
        .onConflictDoUpdate({
            target: [memberSourcesTable.plugin, memberSourcesTable.provider],
            set: {
                enabled: row.enabled,
                signup: row.signup,
                config: row.config,
                updated_at: new Date(),
            },
        });
}
