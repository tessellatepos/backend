import "dotenv/config";
import { and, eq, isNotNull } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { configDevicesTable } from "./schema";
import { drizzleDB } from "@/services/db/postgres";
import type { DeviceType } from "@tessellatepos/sdk";

type TDrizzleDB = typeof drizzleDB;

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

    console.log(deviceConfig);
    console.log("Creating config device");
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

export async function getPairedDeviceByType(
    deviceType: DeviceType,
    db: TDrizzleDB = drizzleDB,
) {
    const deviceConfig = await db
        .select()
        .from(configDevicesTable)
        .where(
            and(
                eq(configDevicesTable.device_type, deviceType),
                isNotNull(configDevicesTable.paired_at),
                isNotNull(configDevicesTable.device_hardware_id),
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
    console.log("Deleting config device with id:", id);
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
