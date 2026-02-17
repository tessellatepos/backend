import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js"
import { eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { configDevicesTable } from "./schema";

const db = drizzle(process.env.DATABASE_URL!);

async function createConfigDevice() {
    const deviceConfig: typeof configDevicesTable.$inferInsert = {
        id: generateDeviceNanoID(),
        created_at: new Date(),
        paring_code: generateParingCode(),
        code_created_at: new Date(),
        paired_at: null,
        square_location: null,
        customer_facing: false,
        device_hardware_id: null,
    }

    await db.insert(configDevicesTable).values(deviceConfig);
    return deviceConfig;
}

async function getConfigDeviceByPairingCode(paring_code: string) {
    const deviceConfig = await db.select().from(configDevicesTable).where(eq(configDevicesTable.paring_code, paring_code)).limit(1);
    return deviceConfig[0] || null;
}

async function getConfigDeviceByID(id: string) {
    const deviceConfig = await db.select().from(configDevicesTable).where(eq(configDevicesTable.id, id)).limit(1);
    return deviceConfig[0] || null;
}

async function updateConfigDevice(id: string, updates: Partial<typeof configDevicesTable.$inferInsert>) {
    await db.update(configDevicesTable).set(updates).where(eq(configDevicesTable.id, id));
}

async function deleteConfigDevice(id: string) {
    await db.delete(configDevicesTable).where(eq(configDevicesTable.id, id));
}

function generateDeviceNanoID() {
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    const nanoid = customAlphabet(alphabet, 12);
    return nanoid();
}

function generateParingCode() {
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    const nanoid = customAlphabet(alphabet, 8);
    return nanoid();
}