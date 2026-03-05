import EventEmitter from "node:events";

export type DatabaseEvent =
    | { type: "order_created"; payload: { orderId: string } }
    | { type: "order_updated"; payload: { orderId: string } }
    | { type: "device_paired"; payload: { deviceId: string } };

class AppEventEmitter extends EventEmitter {}

export const appEvents = new AppEventEmitter();

export function emitDatabaseEvent(event: DatabaseEvent) {
    appEvents.emit("db_update", event);
}
