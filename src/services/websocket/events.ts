import EventEmitter from "node:events";

export type DatabaseEvent =
    | { type: "order_created"; payload: { orderId: string } }
    | { type: "order_updated"; payload: { orderId: string } }
    | { type: "device_paired"; payload: { deviceId: string } };

export type PaymentStatusEvent = {
    type: "payment_status";
    payload: {
        orderId: string;
        status: "COMPLETED" | "FAILED";
        paymentMethod: "MOBILE_READER" | "TERMINAL" | "CASH";
        paymentId?: string;
    };
};

class AppEventEmitter extends EventEmitter {}

export const appEvents = new AppEventEmitter();

export function emitDatabaseEvent(event: DatabaseEvent) {
    appEvents.emit("db_update", event);
}

export function emitPaymentStatusEvent(event: PaymentStatusEvent) {
    appEvents.emit("payment_status", event);
}
