import "dotenv/config";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { configDevicesTable } from "./schema";
import { drizzleDB } from "@/services/db/postgres";
import type { DeviceType } from "@tessellatepos/sdk";

type TDrizzleDB = typeof drizzleDB;

/** What the LOCAL helpers need, so they also run inside a transaction. */
type TDeviceDB = Pick<TDrizzleDB, "select" | "insert" | "delete">;

export async function createConfigDevice(db: TDrizzleDB = drizzleDB) {
    const deviceConfig: typeof configDevicesTable.$inferInsert = {
        id: generateDeviceNanoID(),
        createdAt: new Date(),
        pairingCode: generatePairingCode(),
        codeCreatedAt: new Date(),
        pairedAt: null,
        squareLocation: null,
        customerFacing: false,
        deviceHardwareId: null,
        deviceType: null,
    };

    await db.insert(configDevicesTable).values(deviceConfig);
    return deviceConfig;
}

export async function getAllConfigDevices(db: TDrizzleDB = drizzleDB) {
    return db.select().from(configDevicesTable);
}

export async function getConfigDeviceByPairingCode(
    pairingCode: string,
    db: TDrizzleDB = drizzleDB,
) {
    const deviceConfig = await db
        .select()
        .from(configDevicesTable)
        .where(eq(configDevicesTable.pairingCode, pairingCode))
        .limit(1);
    return deviceConfig[0] || null;
}

export async function getConfigDeviceByID(
    id: string,
    db: TDrizzleDB = drizzleDB,
) {
    const deviceConfig = await db
        .select()
        .from(configDevicesTable)
        .where(eq(configDevicesTable.id, id))
        .limit(1);
    return deviceConfig[0] || null;
}

export async function getConfigDeviceByTokenHash(
    tokenHash: string,
    db: TDrizzleDB = drizzleDB,
) {
    const deviceConfig = await db
        .select()
        .from(configDevicesTable)
        .where(eq(configDevicesTable.deviceTokenHash, tokenHash))
        .limit(1);
    return deviceConfig[0] || null;
}

/**
 * Drops the token hash so a device record is safe to send to clients.
 * @param device a devices row
 * @returns the row without `deviceTokenHash`
 */
export function withoutTokenHash<T extends object>(
    device: T,
): Omit<T, "deviceTokenHash"> {
    const rest = { ...device } as Record<string, unknown>;
    delete rest.deviceTokenHash;
    return rest as Omit<T, "deviceTokenHash">;
}

/**
 * Creates a LOCAL till pinned to a location, or returns the one it already has.
 * It is paired from the start, so it has no pairing code and no hardware id.
 * @param locationId the location the till sells for (any provider's id)
 * @returns the device row, inserted or existing (it has no token hash)
 */
export async function createLocalDevice(
    locationId: string,
    db: TDeviceDB = drizzleDB,
) {
    const now = new Date();
    const deviceConfig: typeof configDevicesTable.$inferInsert = {
        id: generateDeviceNanoID(),
        createdAt: now,
        pairingCode: null,
        codeCreatedAt: null,
        pairedAt: now,
        squareLocation: locationId,
        customerFacing: false,
        deviceHardwareId: null,
        deviceType: "LOCAL",
    };
    // A concurrent create for the same location loses here and gets the row
    // the winner inserted, so the till is never duplicated.
    const inserted = await db
        .insert(configDevicesTable)
        .values(deviceConfig)
        .onConflictDoNothing({
            target: configDevicesTable.squareLocation,
            where: sql`tessellate_is_local_till(${configDevicesTable.deviceType})`,
        })
        .returning({ id: configDevicesTable.id });
    if (inserted.length > 0) {
        return deviceConfig;
    }
    const existing = await getLocalDeviceForLocation(locationId, db);
    if (!existing) {
        throw new Error(
            `LOCAL device for ${locationId} vanished after conflict`,
        );
    }
    return existing;
}

/**
 * The LOCAL device pinned to a location, if there is one. The endpoint that
 * creates them is idempotent, so there is normally at most one.
 * @param locationId the location id
 * @returns the device row, or null
 */
export async function getLocalDeviceForLocation(
    locationId: string,
    db: TDeviceDB = drizzleDB,
) {
    const rows = await db
        .select()
        .from(configDevicesTable)
        .where(
            and(
                eq(configDevicesTable.deviceType, "LOCAL"),
                eq(configDevicesTable.squareLocation, locationId),
            ),
        )
        .limit(1);
    return rows[0] || null;
}

/**
 * Every LOCAL device, so a list of locations can show each one's till.
 * @returns the LOCAL device rows
 */
export async function getLocalDevices(db: TDeviceDB = drizzleDB) {
    return db
        .select()
        .from(configDevicesTable)
        .where(eq(configDevicesTable.deviceType, "LOCAL"));
}

/**
 * Deletes the LOCAL devices pinned to a location. Takes a transaction, so a
 * storefront delete can remove its till atomically.
 * @param locationId the location id
 */
export async function deleteLocalDevicesForLocation(
    locationId: string,
    db: TDeviceDB = drizzleDB,
) {
    await db
        .delete(configDevicesTable)
        .where(
            and(
                eq(configDevicesTable.deviceType, "LOCAL"),
                eq(configDevicesTable.squareLocation, locationId),
            ),
        );
}

export async function getPairedDeviceByType(
    deviceType: DeviceType,
    db: TDrizzleDB = drizzleDB,
) {
    // TERMINAL devices pair through Square's own Device Code flow (squareDeviceId);
    // MOBILE_READER devices pair through our OTP flow (deviceHardwareId).
    // LOCAL devices are filtered out by deviceType and never match here.
    const pairingIdentifierColumn =
        deviceType === "TERMINAL"
            ? configDevicesTable.squareDeviceId
            : configDevicesTable.deviceHardwareId;

    const deviceConfig = await db
        .select()
        .from(configDevicesTable)
        .where(
            and(
                eq(configDevicesTable.deviceType, deviceType),
                isNotNull(configDevicesTable.pairedAt),
                isNotNull(pairingIdentifierColumn),
            ),
        )
        .limit(1);
    return deviceConfig[0] || null;
}

export async function updateConfigDevice(
    id: string,
    updates: Partial<typeof configDevicesTable.$inferInsert>,
    db: TDrizzleDB = drizzleDB,
) {
    await db
        .update(configDevicesTable)
        .set(updates)
        .where(eq(configDevicesTable.id, id));
}

export async function deleteConfigDevice(
    id: string,
    db: TDrizzleDB = drizzleDB,
) {
    await db.delete(configDevicesTable).where(eq(configDevicesTable.id, id));
}

function generateDeviceNanoID() {
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const nanoid = customAlphabet(alphabet, 12);
    return nanoid();
}

export function generatePairingCode() {
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const nanoid = customAlphabet(alphabet, 8);
    return nanoid();
}
