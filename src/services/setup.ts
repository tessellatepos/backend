import { and, count, eq, isNotNull, isNull, or, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
    COUNTRIES,
    CURRENCIES,
    validateAddress,
    type Address,
    type CurrencyCode,
    type Location,
} from "@tessellatepos/sdk";
import { getAuth } from "@/services/auth";
import { drizzleDB, pool } from "@/services/db/postgres";
import {
    authUserTable,
    configDevicesTable,
    locationsTable,
    setupStateTable,
} from "@/services/db/schema";
import {
    EMPTY_HOURS,
    getLocationById,
    locationStore,
} from "@/services/db/locations";
import { isAuthorized } from "@/services/squareOauth";
import { getActiveProviderId } from "@/services/providers";
import {
    clearSetupToken,
    isSetupTokenRequired,
    setupTokenMatches,
} from "@/services/setupToken";

/** Which first-run steps are done, derived from the database. */
export interface SetupSteps {
    owner: boolean;
    store: boolean;
    provider: boolean;
    device: boolean;
}

/** Response of GET /setup/status. */
export interface SetupStatus {
    needsSetup: boolean;
    setupTokenRequired: boolean;
    provider: "local" | "square";
    squareConnected: boolean;
    steps: SetupSteps;
}

/** Input to {@link createOwner}. */
export interface OwnerInput {
    name: string;
    username: string;
    email: string;
    password: string;
}

/** Machine-readable reason attached to the 409 responses. */
export type SetupErrorCode =
    | "SETUP_COMPLETE"
    | "USER_EXISTS"
    | "BAD_TOKEN"
    | "PROVIDER_SQUARE"
    | "STORE_EXISTS"
    | "MISSING_STEPS";

/** A failure the endpoint maps to an HTTP status. */
export class SetupError extends Error {
    readonly status: 400 | 403 | 409;
    readonly code?: SetupErrorCode;
    readonly missing?: string[];

    constructor(
        status: 400 | 403 | 409,
        message: string,
        code?: SetupErrorCode,
        missing?: string[],
    ) {
        super(message);
        this.status = status;
        this.code = code;
        this.missing = missing;
    }
}

/** Advisory lock key serialising owner creation. */
const OWNER_LOCK_KEY = 7351003;
/** Advisory lock key serialising first-store creation. */
const STORE_LOCK_KEY = 7351004;

async function countRows(
    table: typeof authUserTable | typeof locationsTable,
): Promise<number> {
    const [row] = await drizzleDB.select({ n: count() }).from(table);
    return row.n;
}

/** @returns true once setup has been marked complete */
export async function isSetupComplete(): Promise<boolean> {
    const [row] = await drizzleDB
        .select({ id: setupStateTable.id })
        .from(setupStateTable)
        .where(eq(setupStateTable.id, 1))
        .limit(1);
    return Boolean(row);
}

/** @returns true when at least one user exists */
export async function hasUsers(): Promise<boolean> {
    return (await countRows(authUserTable)) > 0;
}

/**
 * Builds the public setup status. Contains no secrets.
 * @returns the status document
 */
export async function getSetupStatus(): Promise<SetupStatus> {
    const provider = getActiveProviderId();
    const [complete, users, locations, devices, squareConnected] =
        await Promise.all([
            isSetupComplete(),
            countRows(authUserTable),
            countRows(locationsTable),
            drizzleDB
                .select({ n: count() })
                .from(configDevicesTable)
                // A LOCAL till needs no hardware, so it does not count as a
                // paired device for the setup checklist.
                .where(
                    and(
                        isNotNull(configDevicesTable.paired_at),
                        or(
                            isNull(configDevicesTable.device_type),
                            ne(configDevicesTable.device_type, "LOCAL"),
                        ),
                    ),
                )
                .then(([r]) => r.n),
            isAuthorized(),
        ]);
    return {
        needsSetup: !complete,
        setupTokenRequired: users === 0 && isSetupTokenRequired(),
        provider,
        squareConnected,
        steps: {
            owner: users > 0,
            store: locations > 0,
            provider: provider === "local" || squareConnected,
            device: devices > 0,
        },
    };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_.]{3,30}$/;

function str(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

/**
 * Validates owner input.
 * @param body the raw request body
 * @param minPasswordLength better-auth's configured minimum
 * @returns the cleaned input
 * @throws SetupError(400) when invalid
 */
export function parseOwnerInput(
    body: Record<string, unknown>,
    minPasswordLength: number,
): OwnerInput {
    const name = str(body.name);
    const username = str(body.username);
    const email = str(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    if (!name) throw new SetupError(400, "name is required");
    if (!USERNAME_RE.test(username)) {
        throw new SetupError(
            400,
            "username must be 3-30 letters, numbers, dots or underscores",
        );
    }
    if (!EMAIL_RE.test(email)) throw new SetupError(400, "email is invalid");
    if (password.length < minPasswordLength || password.length > 128) {
        throw new SetupError(
            400,
            `password must be ${minPasswordLength}-128 characters`,
        );
    }
    return { name, username, email, password };
}

/**
 * Checks a setup token without creating anything, so the wizard can reject a
 * wrong token before the owner form is filled in. Same checks, in the same
 * order, as {@link createOwner} before it reads the form. Succeeds without a
 * token when SETUP_TOKEN is unset.
 * @param token the setup token the caller supplied
 * @throws SetupError 403 (wrong or missing token), 409 (user exists / complete)
 */
export async function verifySetupToken(token: unknown): Promise<void> {
    if (await isSetupComplete()) {
        throw new SetupError(
            409,
            "Setup is already complete",
            "SETUP_COMPLETE",
        );
    }
    if (await hasUsers())
        throw new SetupError(409, "An owner already exists", "USER_EXISTS");
    if (isSetupTokenRequired() && !setupTokenMatches(token)) {
        throw new SetupError(403, "Invalid setup token", "BAD_TOKEN");
    }
}

/**
 * Creates the first user as owner and signs them in. The check "no users
 * yet" and the creation happen while holding a Postgres advisory lock held
 * by an open transaction, so concurrent callers are serialised and only the
 * first can win.
 * @param token the setup token the caller supplied
 * @param body the raw request body
 * @returns the created user and the Set-Cookie headers for the session
 * @throws SetupError 403 (token), 409 (user exists / complete), 400 (input)
 */
export async function createOwner(
    token: unknown,
    body: Record<string, unknown>,
): Promise<{
    user: { id: string; name: string; username: string; email: string };
    setCookies: string[];
}> {
    if (await isSetupComplete()) {
        throw new SetupError(
            409,
            "Setup is already complete",
            "SETUP_COMPLETE",
        );
    }
    if (await hasUsers())
        throw new SetupError(409, "An owner already exists", "USER_EXISTS");
    if (isSetupTokenRequired() && !setupTokenMatches(token)) {
        throw new SetupError(403, "Invalid setup token");
    }
    const auth = getAuth();
    const { minPasswordLength } = (await auth.$context).password.config;
    const input = parseOwnerInput(body, minPasswordLength);

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [
            OWNER_LOCK_KEY,
        ]);
        // Re-check under the lock: a concurrent request may have won.
        const { rows } = await client.query(
            `SELECT 1 FROM "tessellate-auth-user" LIMIT 1`,
        );
        if (rows.length > 0) {
            throw new SetupError(409, "An owner already exists", "USER_EXISTS");
        }
        const { user } = await auth.api.createUser({
            body: {
                email: input.email,
                password: input.password,
                name: input.name,
                role: "owner",
                data: { username: input.username.toLowerCase() },
            },
        });
        await client.query("COMMIT");
        clearSetupToken();
        const { headers } = await auth.api.signInEmail({
            body: { email: input.email, password: input.password },
            returnHeaders: true,
        });
        return {
            user: {
                id: user.id,
                name: user.name,
                username: input.username.toLowerCase(),
                email: user.email,
            },
            setCookies: headers.getSetCookie(),
        };
    } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Creates the first store location (local provider only).
 * @param body the raw request body: name, address, currency
 * @returns the created location
 * @throws SetupError 409 (complete / Square provider), 400 (input)
 */
export async function createStore(
    body: Record<string, unknown>,
): Promise<Location> {
    if (await isSetupComplete()) {
        throw new SetupError(
            409,
            "Setup is already complete",
            "SETUP_COMPLETE",
        );
    }
    if (getActiveProviderId() !== "local") {
        throw new SetupError(
            409,
            "Locations come from Square for this provider",
            "PROVIDER_SQUARE",
        );
    }
    const name = str(body.name);
    if (!name) throw new SetupError(400, "name is required");
    const currency = body.currency;
    if (typeof currency !== "string" || !Object.hasOwn(CURRENCIES, currency)) {
        throw new SetupError(400, "currency is not a known currency code");
    }
    const address = body.address as Address | undefined;
    if (
        !address ||
        typeof address !== "object" ||
        typeof address.country !== "string" ||
        !Object.hasOwn(COUNTRIES, address.country)
    ) {
        throw new SetupError(400, "address with a known country is required");
    }
    const problems = validateAddress(address);
    if (problems.length > 0) {
        throw new SetupError(
            400,
            `address is invalid: ${problems
                .map((p) => `${p.field} ${p.reason}`)
                .join(", ")}`,
        );
    }
    const id = `loc_${nanoid(12)}`;
    // Serialise "no location yet, then create" so a retry cannot duplicate.
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [
            STORE_LOCK_KEY,
        ]);
        if ((await countRows(locationsTable)) > 0) {
            throw new SetupError(
                409,
                "A location already exists",
                "STORE_EXISTS",
            );
        }
        await insertLocation(id, name, address, currency as CurrencyCode);
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
    const location = await getLocationById(id);
    if (!location) throw new Error("Location was not saved");
    return location;
}

async function insertLocation(
    id: string,
    name: string,
    address: Address,
    currency: CurrencyCode,
): Promise<void> {
    await locationStore.upsert({
        id,
        name,
        address,
        currency,
        phone_number: "",
        website_url: "",
        email: "",
        hours: EMPTY_HOURS,
        logo_url: "",
    });
}

/**
 * Marks setup complete once an owner and a store exist.
 * @throws SetupError 409 when already complete or steps are missing
 */
export async function completeSetup(): Promise<void> {
    if (await isSetupComplete()) {
        throw new SetupError(
            409,
            "Setup is already complete",
            "SETUP_COMPLETE",
        );
    }
    const { steps } = await getSetupStatus();
    const missing = (["owner", "store"] as const).filter((s) => !steps[s]);
    if (missing.length > 0) {
        throw new SetupError(
            409,
            `Setup is missing: ${missing.join(", ")}`,
            "MISSING_STEPS",
            missing,
        );
    }
    await drizzleDB
        .insert(setupStateTable)
        .values({ id: 1, completedAt: new Date() })
        .onConflictDoNothing();
}
