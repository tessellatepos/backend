import type {
    Customer,
    CustomerInput,
    CustomerPage,
    CustomerQuery,
    Item,
    Location,
    Money,
    Order,
    ProviderId,
} from "@tessellatepos/sdk";

/** Static facts about a provider that endpoints and the UI branch on. */
export interface ProviderInfo {
    id: ProviderId;
    /** Terminal checkout needs a hardware device paired with the provider. */
    requiresTerminalDevice: boolean;
    /** Storefronts (locations) can be created and deleted locally. */
    canManageStorefronts: boolean;
}

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

    /**
     * Fetches the business locations the catalog's location ids refer to.
     * @returns the locations
     */
    fetchLocations(): Promise<Location[]>;
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

/**
 * The provider-side customer API. Customers are PII: implementations must
 * not log customer fields, only ids. Writes go to the provider's source of
 * truth and return what it stored, so callers mirror that, not their input.
 */
export interface CustomerProvider {
    /**
     * Lists customers matching a query, one page at a time.
     * @param query text search, filters and paging
     * @returns a page of customers
     */
    listCustomers(query: CustomerQuery): Promise<CustomerPage>;

    /**
     * Fetches one customer.
     * @param id the customer id
     * @returns the customer, or null if it doesn't exist
     */
    getCustomer(id: string): Promise<Customer | null>;

    /**
     * Creates a customer.
     * @param input the customer's details
     * @returns the created customer, with its id and timestamps
     */
    createCustomer(input: CustomerInput): Promise<Customer>;

    /**
     * Replaces a customer's details.
     * @param id the customer id
     * @param input the customer's new details
     * @returns the updated customer, or null if it doesn't exist
     */
    updateCustomer(id: string, input: CustomerInput): Promise<Customer | null>;

    /**
     * Deletes a customer.
     * @param id the customer id
     * @returns true if a customer was deleted, false if it didn't exist
     */
    deleteCustomer(id: string): Promise<boolean>;

    /**
     * Fetches every customer the provider holds, for syncing into Postgres.
     * @returns all customers
     */
    fetchCustomers(): Promise<Customer[]>;
}
