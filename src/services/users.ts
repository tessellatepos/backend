import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { getAuth } from "@/services/auth";
import { drizzleDB } from "@/services/db/postgres";
import { authSessionTable, authUserTable } from "@/services/db/schema";
import { parseRoles } from "@/auth/roles";
import { SetupError, parseOwnerInput } from "@/services/setup";

/** Roles an admin may assign when creating a user (never owner). */
export const CREATABLE_ROLES = ["manager", "cashier", "viewer"] as const;
/** Roles a PATCH may set. */
export const ASSIGNABLE_ROLES = ["owner", ...CREATABLE_ROLES] as const;

/** Machine-readable reason attached to a 409. */
export type UserErrorCode = "USER_EXISTS" | "SELF_CHANGE" | "LAST_OWNER";

/** A failure the endpoint maps to an HTTP status. */
export class UserError extends Error {
    readonly status: 400 | 404 | 409;
    readonly code?: UserErrorCode;

    constructor(
        status: 400 | 404 | 409,
        message: string,
        code?: UserErrorCode,
    ) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

/** A user as the API returns it. Never carries a password or hash. */
export interface UserView {
    id: string;
    name: string;
    username: string | null;
    email: string;
    role: string;
    banned: boolean;
    created_at: string;
}

/** Advisory lock key serialising role and ban changes (last-owner check). */
const USER_CHANGE_LOCK_KEY = 7351005;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type UserRow = typeof authUserTable.$inferSelect;

function view(row: UserRow): UserView {
    return {
        id: row.id,
        name: row.name,
        username: row.username,
        email: row.email,
        role: row.role ?? "viewer",
        banned: row.banned === true,
        created_at: row.createdAt.toISOString(),
    };
}

const isActiveOwner = (row: Pick<UserRow, "role" | "banned">) =>
    parseRoles(row.role).includes("owner") && row.banned !== true;

function oneOf<T extends string>(
    value: unknown,
    allowed: readonly T[],
): value is T {
    return (
        typeof value === "string" &&
        (allowed as readonly string[]).includes(value)
    );
}

/**
 * Lists users oldest first, with an opaque cursor.
 * @param limit page size, 1-200 (default 50)
 * @param cursor the `next_cursor` of the previous page
 * @returns the page and the cursor for the next one, or null at the end
 * @throws UserError 400 for a bad limit or cursor
 */
export async function listUsers(
    limit: number | undefined,
    cursor: string | undefined,
): Promise<{ users: UserView[]; next_cursor: string | null }> {
    const size = limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(size) || size < 1 || size > MAX_LIMIT) {
        throw new UserError(
            400,
            `limit must be an integer from 1 to ${MAX_LIMIT}`,
        );
    }
    let after: { t: string; i: string } | null = null;
    if (cursor) {
        try {
            const parsed = JSON.parse(
                Buffer.from(cursor, "base64url").toString(),
            );
            if (
                typeof parsed?.t !== "string" ||
                typeof parsed?.i !== "string"
            ) {
                throw new Error("shape");
            }
            if (Number.isNaN(Date.parse(parsed.t))) throw new Error("time");
            after = parsed;
        } catch {
            throw new UserError(400, "cursor is invalid");
        }
    }
    // created_at::text keeps Postgres' microseconds, which a JS Date drops.
    const rows = await drizzleDB
        .select({
            user: authUserTable,
            ts: sql<string>`${authUserTable.createdAt}::text`,
        })
        .from(authUserTable)
        .where(
            after
                ? or(
                      gt(authUserTable.createdAt, sql`${after.t}::timestamptz`),
                      and(
                          eq(
                              authUserTable.createdAt,
                              sql`${after.t}::timestamptz`,
                          ),
                          gt(authUserTable.id, after.i),
                      ),
                  )
                : undefined,
        )
        .orderBy(asc(authUserTable.createdAt), asc(authUserTable.id))
        .limit(size + 1);
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return {
        users: page.map((r) => view(r.user)),
        next_cursor:
            rows.length > size && last
                ? Buffer.from(
                      JSON.stringify({ t: last.ts, i: last.user.id }),
                  ).toString("base64url")
                : null,
    };
}

async function findUser(id: string): Promise<UserRow | undefined> {
    const [row] = await drizzleDB
        .select()
        .from(authUserTable)
        .where(eq(authUserTable.id, id))
        .limit(1);
    return row;
}

/**
 * Creates a non-owner user through better-auth, which hashes the password.
 * @param body the raw request body: name, username, email, password, role
 * @returns the created user
 * @throws UserError 400 invalid, 409 USER_EXISTS
 */
export async function createUser(
    body: Record<string, unknown>,
): Promise<UserView> {
    if (!oneOf(body.role, CREATABLE_ROLES)) {
        throw new UserError(
            400,
            `role must be one of ${CREATABLE_ROLES.join(", ")}`,
        );
    }
    const auth = getAuth();
    const { minPasswordLength } = (await auth.$context).password.config;
    let input;
    try {
        input = parseOwnerInput(body, minPasswordLength);
    } catch (err) {
        if (err instanceof SetupError) throw new UserError(400, err.message);
        throw err;
    }
    const username = input.username.toLowerCase();
    const [existing] = await drizzleDB
        .select({ id: authUserTable.id })
        .from(authUserTable)
        .where(
            or(
                eq(
                    sql`lower(${authUserTable.email})`,
                    input.email.toLowerCase(),
                ),
                eq(authUserTable.username, username),
            ),
        )
        .limit(1);
    const exists = () =>
        new UserError(
            409,
            "A user with that email or username already exists",
            "USER_EXISTS",
        );
    if (existing) throw exists();
    try {
        const { user } = await auth.api.createUser({
            body: {
                email: input.email,
                password: input.password,
                name: input.name,
                role: body.role,
                data: { username },
            },
        });
        const row = await findUser(user.id);
        if (!row) throw new Error("created user vanished");
        return view(row);
    } catch (err) {
        // A concurrent create can win between the check and the insert.
        const text = JSON.stringify({
            code: (err as { body?: { code?: string } }).body?.code,
            pg: (err as { cause?: { code?: string } }).cause?.code,
        });
        if (text.includes("USER_ALREADY_EXISTS") || text.includes("23505")) {
            throw exists();
        }
        throw err;
    }
}

/**
 * Changes a user's role, banned flag or name.
 * @param actorId the id of the user making the change
 * @param id the user to change
 * @param body the raw request body: role?, banned?, name?
 * @returns the updated user
 * @throws UserError 400 invalid, 404 unknown, 409 SELF_CHANGE / LAST_OWNER
 */
export async function updateUser(
    actorId: string,
    id: string,
    body: Record<string, unknown>,
): Promise<UserView> {
    const { role, banned, name } = body;
    if (role !== undefined && !oneOf(role, ASSIGNABLE_ROLES)) {
        throw new UserError(
            400,
            `role must be one of ${ASSIGNABLE_ROLES.join(", ")}`,
        );
    }
    if (banned !== undefined && typeof banned !== "boolean") {
        throw new UserError(400, "banned must be a boolean");
    }
    if (
        name !== undefined &&
        (typeof name !== "string" || !name.trim() || name.trim().length > 100)
    ) {
        throw new UserError(400, "name must be 1-100 characters");
    }
    if (role === undefined && banned === undefined && name === undefined) {
        throw new UserError(400, "Provide role, banned or name");
    }

    return drizzleDB.transaction(async (tx) => {
        await tx.execute(
            sql`select pg_advisory_xact_lock(${USER_CHANGE_LOCK_KEY})`,
        );
        const [target] = await tx
            .select()
            .from(authUserTable)
            .where(eq(authUserTable.id, id))
            .limit(1);
        if (!target) throw new UserError(404, "User not found");

        if (
            actorId === id &&
            ((role !== undefined && role !== target.role) || banned === true)
        ) {
            throw new UserError(
                409,
                "You cannot change your own role or ban yourself",
                "SELF_CHANGE",
            );
        }

        const nextRole = role ?? target.role;
        const nextBanned = banned ?? target.banned === true;
        const stays = isActiveOwner({ role: nextRole, banned: nextBanned });
        if (isActiveOwner(target) && !stays) {
            const owners = await tx.select().from(authUserTable);
            const others = owners.filter(
                (u) => u.id !== id && isActiveOwner(u),
            );
            if (others.length === 0) {
                throw new UserError(
                    409,
                    "There must be at least one active owner",
                    "LAST_OWNER",
                );
            }
        }

        const [updated] = await tx
            .update(authUserTable)
            .set({
                ...(role !== undefined ? { role } : {}),
                ...(name !== undefined ? { name: name.trim() } : {}),
                ...(banned !== undefined
                    ? { banned, banReason: null, banExpires: null }
                    : {}),
                updatedAt: new Date(),
            })
            .where(eq(authUserTable.id, id))
            .returning();
        if (banned === true) {
            await tx
                .delete(authSessionTable)
                .where(eq(authSessionTable.userId, id));
        }
        return view(updated);
    });
}

/**
 * Sets a user's password (admin reset) and revokes all their sessions. The
 * password is hashed by better-auth.
 * @param id the user
 * @param password the new password
 * @throws UserError 400 invalid, 404 unknown
 */
export async function resetPassword(
    id: string,
    password: unknown,
): Promise<void> {
    const ctx = await getAuth().$context;
    const { minPasswordLength, maxPasswordLength } = ctx.password.config;
    if (
        typeof password !== "string" ||
        password.length < minPasswordLength ||
        password.length > Math.min(maxPasswordLength, 128)
    ) {
        throw new UserError(
            400,
            `password must be ${minPasswordLength}-128 characters`,
        );
    }
    if (!(await findUser(id))) throw new UserError(404, "User not found");
    const hash = await ctx.password.hash(password);
    const accounts = await ctx.internalAdapter.findAccounts(id);
    if (accounts.some((a) => a.providerId === "credential")) {
        await ctx.internalAdapter.updatePassword(id, hash);
    } else {
        await ctx.internalAdapter.linkAccount({
            userId: id,
            providerId: "credential",
            accountId: id,
            password: hash,
        });
    }
    await drizzleDB
        .delete(authSessionTable)
        .where(eq(authSessionTable.userId, id));
}
