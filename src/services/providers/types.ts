import type {
    CatalogImportReport,
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
import type {
    CategoryNode,
    WriteContext,
    WriteResult,
} from "@/services/db/catalogManage";
import type { ItemDraft, ItemPatch } from "@/services/catalogValidation";
import type { ItemCategoryInput } from "@tessellatepos/sdk";

/** Static facts about a provider that endpoints and the UI branch on. */
export interface ProviderInfo {
    id: ProviderId;
    /** Terminal checkout needs a hardware device paired with the provider. */
    requiresTerminalDevice: boolean;
    /** Storefronts (locations) can be created and deleted locally. */
    canManageStorefronts: boolean;
    /** Items, variations and categories can be created and edited here. */
    canManageCatalog: boolean;
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
 * Catalog writes, for providers that own their catalog. A provider whose
 * catalog lives in an external system (Square) leaves these out, and the
 * catalog endpoints answer 409 for it. Writes are all-or-nothing.
 */
export interface CatalogWriteProvider {
    createItem(draft: ItemDraft, ctx: WriteContext): Promise<WriteResult>;
    /** Replaces (`draft`) or merges onto (`patch`) an item; null if not found. */
    updateItem(
        id: string,
        change: { draft: ItemDraft } | { patch: ItemPatch },
        ctx: WriteContext,
    ): Promise<WriteResult | null>;
    archiveItem(
        id: string,
        archived: boolean,
        ctx: WriteContext,
    ): Promise<WriteResult | null>;
    /** Refused with a 409 CatalogError while an order references the item. */
    deleteItem(
        id: string,
        ctx: WriteContext,
    ): Promise<{ locationIds: string[] } | null>;
    createCategory(input: Partial<ItemCategoryInput>): Promise<CategoryNode>;
    updateCategory(
        id: string,
        input: Partial<ItemCategoryInput>,
    ): Promise<CategoryNode | null>;
    /** @returns false when the category does not exist */
    deleteCategory(id: string): Promise<boolean>;
    importCatalog(
        csv: string,
        options: { dryRun: boolean },
        ctx: WriteContext,
    ): Promise<CatalogImportReport>;
}

/**
 * Payment/checkout operations for a provider. Terminal and mobile-reader
 * methods are optional — not every provider has hardware-reader concepts
 * (an in-house, cash-only provider omits both).
 */
/**
 * Thrown by a provider when a payment can't be applied because the order was
 * already paid or changed underneath it. Maps to HTTP 409, not 500.
 */
export class OrderConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OrderConflictError";
    }
}

/**
 * Thrown by a provider when an order's content is invalid (e.g. a bad
 * client-supplied price). Maps to HTTP 400, not 500.
 */
export class InvalidOrderError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidOrderError";
    }
}

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
