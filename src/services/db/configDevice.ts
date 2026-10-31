import "dotenv/config";
import { and, eq, isNotNull } from "drizzle-orm";
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
        created_at: new Date(),
        pairing_code: generatePairingCode(),
        code_created_at: new Date(),
        paired_at: null,
        square_location: null,
        customer_facing: false,
        device_hardware_id: null,
        device_type: null,
    };

    await db.insert(configDevicesTable).values(deviceConfig);
    return deviceConfig;
}

export async function getAllConfigDevices(db: TDrizzleDB = drizzleDB) {
    return db.select().from(configDevicesTable);
}

export async function getConfigDeviceByPairingCode(
    pairing_code: string,
    db: TDrizzleDB = drizzleDB,
) {
    const deviceConfig = await db
        .select()
        .from(configDevicesTable)
        .where(eq(configDevicesTable.pairing_code, pairing_code))
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
        .where(eq(configDevicesTable.device_token_hash, tokenHash))
        .limit(1);
    return deviceConfig[0] || null;
}

/**
 * Drops the token hash so a device record is safe to send to clients.
 * @param device a devices row
 * @returns the row without `device_token_hash`
 */
export function withoutTokenHash<T extends object>(
    device: T,
): Omit<T, "device_token_hash"> {
    const rest = { ...device } as Record<string, unknown>;
    delete rest.device_token_hash;
    return rest as Omit<T, "device_token_hash">;
}

/**
 * Creates a LOCAL till pinned to a location. It is paired from the start, so
 * it has no pairing code and no hardware id.
 * @param locationId the location the till sells for (any provider's id)
 * @returns the inserted row (it has no token hash)
 */
export async function createLocalDevice(
    locationId: string,
    db: TDeviceDB = drizzleDB,
) {
    const now = new Date();
    const deviceConfig: typeof configDevicesTable.$inferInsert = {
        id: generateDeviceNanoID(),
        created_at: now,
        pairing_code: null,
        code_created_at: null,
        paired_at: now,
        square_location: locationId,
        customer_facing: false,
        device_hardware_id: null,
        device_type: "LOCAL",
    };
    await db.insert(configDevicesTable).values(deviceConfig);
    return deviceConfig;
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
                eq(configDevicesTable.device_type, "LOCAL"),
                eq(configDevicesTable.square_location, locationId),
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
        .where(eq(configDevicesTable.device_type, "LOCAL"));
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
                eq(configDevicesTable.device_type, "LOCAL"),
                eq(configDevicesTable.square_location, locationId),
            ),
        );
}

export async function getPairedDeviceByType(
    deviceType: DeviceType,
    db: TDrizzleDB = drizzleDB,
) {
    // TERMINAL devices pair through Square's own Device Code flow (square_device_id);
    // MOBILE_READER devices pair through our OTP flow (device_hardware_id).
    // LOCAL devices are filtered out by device_type and never match here.
    const pairingIdentifierColumn =
        deviceType === "TERMINAL"
            ? configDevicesTable.square_device_id
            : configDevicesTable.device_hardware_id;

    const deviceConfig = await db
        .select()
        .from(configDevicesTable)
        .where(
            and(
                eq(configDevicesTable.device_type, deviceType),
                isNotNull(configDevicesTable.paired_at),
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
