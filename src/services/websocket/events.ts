import EventEmitter from "node:events";

/**
 * Events fanned out to WebSocket clients. `locationId` is the order's
 * location when the emitter knows it: clients pinned to other locations do
 * not receive the event. Without it, any principal with `orders:read` does.
 * `catalog_updated` needs `catalog:read` instead, and tells tills to refetch.
 */
export type DatabaseEvent =
    | {
          type: "order_created";
          payload: { orderId: string; locationId?: string };
      }
    | {
          type: "order_updated";
          payload: { orderId: string; locationId?: string };
      }
    | { type: "device_paired"; payload: { deviceId: string } }
    | {
          type: "catalog_updated";
          payload: { locationId?: string };
      };

export type PaymentStatusEvent = {
    type: "payment_status";
    payload: {
        orderId: string;
        locationId?: string;
        status: "COMPLETED" | "FAILED";
        paymentMethod: "MOBILE_READER" | "TERMINAL" | "CASH" | "ONLINE";
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
