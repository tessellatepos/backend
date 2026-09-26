import type { Item, Money, Order } from "@tessellatepos/sdk";

/**
 * A source of truth for the item catalog. itemLocationIds is kept separate
 * from Item since location presence is persisted as its own join table
 * (catalog-item-locations), not a field carried on the domain item.
 */
export interface CatalogProvider {
    /**
     * Fetches the full item catalog.
     * @returns the items and, for each item id, the location ids it's present at
     */
    fetchCatalog(): Promise<{
        items: Item[];
        itemLocationIds: Map<string, string[]>;
    }>;
}

/**
 * Payment/checkout operations for a provider. Terminal and mobile-reader
 * methods are optional — not every provider has hardware-reader concepts
 * (an in-house, cash-only provider omits both).
 */
export interface PaymentProvider {
    createOrder(order: Order): Promise<Order | undefined | null>;
    fetchOrder(orderId: string): Promise<Order | undefined | null>;
    createTerminalCheckout?(
        orderId: string,
        amount: Money,
        deviceId: string,
    ): Promise<string | null | undefined>;
    getTerminalCheckoutStatus?(
        checkoutId: string,
    ): Promise<string | null | undefined>;
    payCash(
        orderId: string,
        amountTendered: Money,
        orderAmount: Money,
    ): Promise<Money | null>;
    confirmMobileReaderPayment?(
        orderId: string,
        paymentId: string,
    ): Promise<boolean>;
}

export interface DeviceCodePairing {
    id: string;
    code: string;
    status: string;
    pairBy?: string;
    deviceId?: string;
}

/**
 * Pairs physical hardware (e.g. a Square Terminal) to this merchant account.
 * Optional — providers without a hardware device-registration concept (an
 * in-house cash-only provider) omit it.
 */
export interface DevicePairingProvider {
    createDeviceCode?(
        locationId: string,
        name: string,
    ): Promise<DeviceCodePairing | null>;
    getDeviceCode?(id: string): Promise<DeviceCodePairing | null>;
}
