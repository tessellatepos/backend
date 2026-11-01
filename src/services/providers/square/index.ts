import { Currency, OrderLineItem, SquareClient, SquareError } from "square";
import type { DayOfWeek, Location as SquareLocation } from "square";
import type {
    CountryCode,
    CurrencyCode,
    Item,
    ItemVariation,
    ItemCategory,
    ItemVariationLocationOverrides,
    Order,
    Money,
    CartItem as CartItemType,
    Customer,
    CustomerInput,
    CustomerPage,
    CustomerQuery,
    Location,
    LocationHours,
} from "@tessellatepos/sdk";
import { COUNTRIES, toBigIntAmount } from "@tessellatepos/sdk";
import { configDotenv } from "dotenv";
import { Logger } from "tslog";
import type {
    squareHelperCategory,
    squareHelperItemVariation,
} from "./helpers";
import type {
    CatalogProvider,
    CustomerProvider,
    PaymentProvider,
    DevicePairingProvider,
    DeviceCodePairing,
} from "../types";
import {
    canWriteTags,
    mapSquareCustomer,
    pageCustomers,
    toSquareCreateBody,
    toSquareUpdateBody,
} from "./customers";
import {
    getDecryptedAccessToken,
    getSquareEnvironment,
} from "@/services/squareOauth";

configDotenv();

const logger = new Logger();

/**
 * Resolves the token each request goes out with: the seller's stored OAuth
 * access token, refreshed on demand. SQUARE_TOKEN remains a development
 * fallback for a deployment that hasn't been through the OAuth flow yet.
 * @returns a Square access token
 */
async function resolveAccessToken(): Promise<string> {
    const oauthToken = await getDecryptedAccessToken();
    if (oauthToken) {
        return oauthToken;
    }

    if (process.env.SQUARE_TOKEN) {
        return process.env.SQUARE_TOKEN;
    }

    throw new Error(
        "Square is not connected — complete the OAuth flow in Settings or set SQUARE_TOKEN",
    );
}

/**
 * Square Client instance. The token is supplied per request rather than
 * captured at startup so a newly-completed authorization (or a refresh) takes
 * effect without restarting the server.
 */
const client = new SquareClient({
    token: () => resolveAccessToken(),
    environment: getSquareEnvironment(),
});

function mapPricingType(
    pricingType?: string,
): "FIXED" | "VARIABLE" | undefined {
    if (pricingType === "FIXED_PRICING") return "FIXED";
    if (pricingType === "VARIABLE_PRICING") return "VARIABLE";
    return undefined;
}

/**
 * Maps a Square order's line items (which carry pricing under
 * `basePriceMoney`) back into the app's `CartItem` shape (`priceMoney`), so
 * that order responses can be rendered by the same components as the
 * client-side cart.
 * @param lineItems the line items returned by the Square Orders API (Square
 * types these as nullable — `OrderLineItem[] | null`)
 * @returns the app's CartItem representation of those line items
 */
function mapSquareOrderLineItems(
    lineItems: OrderLineItem[] | null | undefined,
): CartItemType[] | undefined {
    return lineItems?.map((li) => ({
        itemId: li.catalogObjectId,
        name: li.name ?? li.variationName,
        quantity: li.quantity ? BigInt(li.quantity) : undefined,
        priceMoney: li.basePriceMoney
            ? {
                  amount: toBigIntAmount(li.basePriceMoney.amount ?? 0),
                  currency: li.basePriceMoney.currency as Money["currency"],
              }
            : undefined,
    }));
}

/**
 * Fetches the item catalog from Square.
 * @returns the items and, for each item id, the location ids it's present at
 */
async function fetchCatalog(): ReturnType<CatalogProvider["fetchCatalog"]> {
    const response = await client.catalog.list();
    const items: Item[] = [];
    const itemLocationIds = new Map<string, string[]>();

    // Iterate through the Page results
    for await (const item of response) {
        if (item.type === "ITEM") {
            if (!item.itemData) continue;

            const imageId = item.itemData.imageIds?.[0];
            const image = imageId ? await fetchSquareImage(imageId) : null;

            const rawVariations = item.itemData.variations as
                squareHelperItemVariation[] | undefined;
            const variations: ItemVariation[] = [];
            // prepare a minimal parent summary (id + name) to attach to each variation
            const parentSummary = {
                id: item.id,
                name: item.itemData.name,
            };

            for (const varItem of rawVariations || []) {
                if (!varItem.itemVariationData) continue;
                const variation: ItemVariation = {
                    itemId: varItem.id,
                    name: varItem.itemVariationData.name,
                    sku: varItem.itemVariationData.sku,
                    upc: varItem.itemVariationData.upc,
                    ordinal: varItem.itemVariationData.ordinal,
                    pricingType: mapPricingType(
                        varItem.itemVariationData.pricingType,
                    ),
                    priceMoney: varItem.itemVariationData.priceMoney,
                    locationOverrides:
                        varItem.itemVariationData.locationOverrides?.map(
                            (lo) =>
                                ({
                                    locationId: lo.locationId,
                                    priceMoney: lo.priceMoney,
                                    pricingType: mapPricingType(lo.pricingType),
                                    trackInventory: lo.trackInventory,
                                }) as ItemVariationLocationOverrides,
                        ),
                    trackInventory: varItem.itemVariationData.trackInventory,
                    parent: parentSummary,
                };
                variations.push(variation);
            }

            //get categories
            const rawCategories = item.itemData.categories as
                squareHelperCategory[] | undefined;
            const categories: ItemCategory[] = [];
            for (const cat of rawCategories || []) {
                if (!cat.id) continue;
                const category = await fetchSquareCategory(cat.id);
                categories.push(category);
            }

            //Construct the catalog item
            const catalogItem: Item = {
                id: item.id,
                name: item.itemData.name,
                displayName: item.itemData.buyerFacingName,
                labelColor: item.itemData.labelColor,
                isTaxable: item.itemData.isTaxable,
                variations: variations,
                categories: categories,
                isArchived: item.itemData.isArchived,
                image: image,
            };
            items.push(catalogItem);

            if (item.presentAtLocationIds) {
                itemLocationIds.set(item.id, item.presentAtLocationIds);
            }
        }
    }
    return { items, itemLocationIds };
}

/**
 * Fetches the image URL for a given Square image ID.
 * @param id The id of the image object
 * @returns {Promise<string>} The image URL.
 */
async function fetchSquareImage(id: string): Promise<string> {
    const response = await client.catalog.object.get({ objectId: id });
    if (response.object?.type === "IMAGE") {
        return response.object.imageData?.url || "";
    }
    return "";
}

/**
 * Fetches the category for a given Square image ID.
 * @param id The id of the category object
 * @returns {Promise<ItemCategory>} The Square Item Category.
 */
async function fetchSquareCategory(id: string): Promise<ItemCategory> {
    const response = await client.catalog.object.get({ objectId: id });
    if (response.object?.type === "CATEGORY") {
        const resp = response.object;

        let parentCategory: ItemCategory = {};
        const parentId = resp.categoryData?.parentCategory?.id;
        if (parentId) {
            parentCategory = await fetchSquareCategory(parentId);
        }

        const category: ItemCategory = {
            id: resp.id,
            name: resp.categoryData?.name,
            parentCategory,
            imageId: resp.categoryData?.imageIds
                ? resp.categoryData.imageIds[0]
                : null,
            imageURL: resp.categoryData?.imageIds
                ? await fetchSquareImage(resp.categoryData.imageIds[0])
                : null,
        };
        return category;
    }
    return {};
}

const SQUARE_DAYS: Record<DayOfWeek, keyof LocationHours> = {
    SUN: "sunday",
    MON: "monday",
    TUE: "tuesday",
    WED: "wednesday",
    THU: "thursday",
    FRI: "friday",
    SAT: "saturday",
};

/**
 * Maps Square's flat list of business-hours periods into per-day periods.
 * Square reports local times, so each is tagged with the location's timezone.
 * @param location the Square location
 * @returns the location's hours, with an empty list for closed days
 */
function mapSquareHours(location: SquareLocation): LocationHours {
    const hours: LocationHours = {
        sunday: [],
        monday: [],
        tuesday: [],
        wednesday: [],
        thursday: [],
        friday: [],
        saturday: [],
    };
    const timezone = location.timezone ?? "";

    for (const period of location.businessHours?.periods ?? []) {
        if (!period.dayOfWeek || !period.startLocalTime || !period.endLocalTime)
            continue;
        hours[SQUARE_DAYS[period.dayOfWeek]].push({
            open: { time: period.startLocalTime, timezone },
            close: { time: period.endLocalTime, timezone },
        });
    }
    return hours;
}

/**
 * Maps a Square location into the provider-agnostic Location.
 * @param location the Square location, which must have an id
 * @returns the location
 */
function mapSquareLocation(
    location: SquareLocation & { id: string },
): Location {
    const address = location.address;
    const country = (address?.country ?? location.country) as CountryCode;
    const addressLine2 = [address?.addressLine2, address?.addressLine3]
        .filter(Boolean)
        .join(", ");

    return {
        id: location.id,
        name: location.name ?? location.businessName ?? location.id,
        address: {
            country,
            organization: location.businessName ?? undefined,
            address_line_1: address?.addressLine1 ?? "",
            address_line_2: addressLine2 || undefined,
            dependent_locality: address?.sublocality ?? undefined,
            locality: address?.locality ?? undefined,
            subdivision: address?.administrativeDistrictLevel1 ?? undefined,
            postal_code: address?.postalCode ?? undefined,
        },
        currency:
            (location.currency as CurrencyCode | undefined) ??
            COUNTRIES[country]?.currency,
        phone_number: location.phoneNumber ?? "",
        website_url: location.websiteUrl ?? "",
        email: location.businessEmail ?? "",
        hours: mapSquareHours(location),
        logo_url: location.logoUrl ?? "",
    };
}

/**
 * Fetches the seller's locations from Square.
 * @returns the locations
 */
async function fetchLocations(): Promise<Location[]> {
    const response = await client.locations.list();
    return (response.locations ?? [])
        .filter((location): location is SquareLocation & { id: string } =>
            Boolean(location.id),
        )
        .map(mapSquareLocation)
        .filter((location) => {
            // Locations are persisted with a required currency; one with
            // neither a currency nor a known country would fail the import.
            if (!location.currency) {
                console.warn(
                    `Skipping Square location ${location.id}: unknown currency`,
                );
            }
            return Boolean(location.currency);
        });
}

/**
 * Creates an order with square
 * @param order the order to create
 * @returns the created order
 */
async function createOrder(order: Order): Promise<Order | undefined | null> {
    if (!order.lineItems) {
        return null;
    }

    const idempotencyKey = crypto.randomUUID();
    const response = await client.orders.create({
        idempotencyKey: idempotencyKey,
        order: {
            locationId: order.locationId,
            lineItems: order.lineItems.map((li) => {
                const lineItem: OrderLineItem = {
                    quantity: li.quantity!.toString(),
                    catalogObjectId: li.itemId,
                };
                if (li.pricingType === "VARIABLE" && li.priceMoney) {
                    lineItem.basePriceMoney = {
                        amount: toBigIntAmount(li.priceMoney.amount),
                        currency: li.priceMoney.currency as Currency,
                    };
                }
                return lineItem;
            }),
            referenceId: order.referenceId,
            source: order.source,
            customerId: order.customerId ?? undefined,
        },
    });

    if (response?.order) {
        return {
            ...response.order,
            lineItems: mapSquareOrderLineItems(response.order.lineItems),
        } as Order;
    }
}

/**
 * Fetches an order from Square by ID
 * @param orderId the id of the order to fetch
 * @returns the order, or null if it doesn't exist
 */
async function fetchOrder(orderId: string): Promise<Order | undefined | null> {
    if (!orderId) {
        return null;
    }

    const response = await client.orders.get({ orderId });

    if (response?.order) {
        return {
            ...response.order,
            lineItems: mapSquareOrderLineItems(response.order.lineItems),
        } as Order;
    }
}

/**
 * Creates a terminal checkour
 * @param orderId the order id for the checkout process
 * @param amount the amount to check out with a square terminal
 * @param deviceId the device id to create the order on
 * @returns the terminal checkout id
 */
async function createTerminalCheckout(
    orderId: string,
    amount: Money,
    deviceId: string,
) {
    if (!orderId || !amount || !deviceId) {
        return null;
    }

    const idempotencyKey = crypto.randomUUID();
    const response = await client.terminal.checkouts.create({
        idempotencyKey: idempotencyKey,
        checkout: {
            amountMoney: {
                currency: amount.currency as Currency,
                amount: amount.amount,
            },
            deviceOptions: {
                deviceId: deviceId,
                showItemizedCart: true,
            },
            orderId: orderId,
        },
    });

    if (response) {
        return response.checkout?.id;
    }
}

/**
 * Checks the status of a terminal order
 * @param checkoutId the id of the checkout
 * @returns the status of the checkout
 */
async function getTerminalCheckoutStatus(checkoutId: string) {
    if (!checkoutId) {
        return null;
    }

    const response = await client.terminal.checkouts.get({
        checkoutId: checkoutId,
    });

    if (response) {
        return response.checkout?.status;
    }
}

/**
 * Starts pairing a physical Square Terminal to this merchant account. The
 * returned code is entered on the terminal's own screen; the terminal is
 * only usable for checkouts (a real Square `device_id`) once that happens.
 * @param locationId the Square location the terminal belongs to
 * @param name a human-readable label for the terminal, shown in Square's dashboard
 * @returns the pending device code, or null if Square rejected the request
 */
async function createDeviceCode(
    locationId: string,
    name: string,
): Promise<DeviceCodePairing | null> {
    if (!locationId) {
        return null;
    }

    const idempotencyKey = crypto.randomUUID();
    const response = await client.devices.codes.create({
        idempotencyKey,
        deviceCode: {
            name,
            productType: "TERMINAL_API",
            locationId,
        },
    });

    const deviceCode = response.deviceCode;
    if (!deviceCode?.id || !deviceCode.code) {
        return null;
    }

    return {
        id: deviceCode.id,
        code: deviceCode.code,
        status: deviceCode.status ?? "UNKNOWN",
        pairBy: deviceCode.pairBy,
    };
}

/**
 * Checks whether a pending device code has been paired yet.
 * @param id the Square DeviceCode id returned from createDeviceCode
 * @returns the device code's current status, and Square's device id once paired
 */
async function getDeviceCode(id: string): Promise<DeviceCodePairing | null> {
    if (!id) {
        return null;
    }

    const response = await client.devices.codes.get({ id });
    const deviceCode = response.deviceCode;
    if (!deviceCode?.id || !deviceCode.code) {
        return null;
    }

    return {
        id: deviceCode.id,
        code: deviceCode.code,
        status: deviceCode.status ?? "UNKNOWN",
        pairBy: deviceCode.pairBy,
        deviceId: deviceCode.deviceId,
    };
}

/**
 * Verifies a payment taken by the Square Mobile Payments SDK (phone-attached
 * Reader) actually belongs to the given order before we trust it. We never
 * see a card nonce for this path — the mobile app hands us a paymentId and
 * we confirm it here.
 * @param orderId the order the payment should be for
 * @param paymentId the Square payment id returned by the Mobile Payments SDK
 * @returns true if the payment is COMPLETED, for this order, and its amount matches the order total
 */
async function confirmMobileReaderPayment(
    orderId: string,
    paymentId: string,
): Promise<boolean> {
    if (!orderId || !paymentId) {
        return false;
    }

    const response = await client.payments.get({ paymentId });
    const payment = response.payment;
    if (!payment) {
        return false;
    }

    if (payment.orderId !== orderId) {
        return false;
    }

    if (payment.status !== "COMPLETED") {
        return false;
    }

    const order = await fetchOrder(orderId);
    if (!order?.totalMoney?.amount || !payment.amountMoney?.amount) {
        return false;
    }

    return payment.amountMoney.amount === order.totalMoney.amount;
}

/**
 * Pays an order with cash. Square requires amountMoney to equal the order
 * total when a payment is attached to an orderId — what the customer
 * actually handed over goes in cashDetails.buyerSuppliedMoney, and Square
 * computes changeBackMoney as the difference itself.
 * @param orderId the order to pay
 * @param amountTendered the cash amount the customer handed over
 * @param orderAmount the order's total (must match amountMoney sent to Square)
 * @returns the change due back to the customer
 */
async function payCash(
    orderId: string,
    amountTendered: Money,
    orderAmount: Money,
) {
    if (!orderId || !amountTendered || !orderAmount) {
        return null;
    }

    const idempotencyKey = crypto.randomUUID();
    const response = await client.payments.create({
        idempotencyKey: idempotencyKey,
        sourceId: "CASH",
        amountMoney: {
            amount: orderAmount.amount,
            currency: orderAmount.currency as Currency,
        },
        autocomplete: true,
        cashDetails: {
            buyerSuppliedMoney: {
                amount: amountTendered.amount,
                currency: amountTendered.currency as Currency,
            },
        },
        orderId: orderId,
    });

    return response.payment?.cashDetails?.changeBackMoney as Money;
}

/**
 * Whether an error is Square saying the record does not exist.
 * @param error the thrown error
 * @returns true for a 404
 */
function isNotFound(error: unknown): boolean {
    return error instanceof SquareError && error.statusCode === 404;
}

/**
 * Fetches every customer from Square.
 * @returns all customers
 */
async function fetchCustomers(): Promise<Customer[]> {
    const customers: Customer[] = [];
    for await (const customer of await client.customers.list()) {
        if (customer.id) {
            customers.push(
                mapSquareCustomer(customer as typeof customer & { id: string }),
            );
        }
    }
    return customers;
}

/**
 * Lists customers matching a query. Answered from the full Square list,
 * since Square's search cannot match text across names, email and phone.
 * Reads normally go through the Postgres mirror instead.
 * @param query text search, filters and paging
 * @returns a page of customers
 */
async function listCustomers(query: CustomerQuery): Promise<CustomerPage> {
    return pageCustomers(await fetchCustomers(), query);
}

/**
 * Fetches one customer from Square.
 * @param id the customer id
 * @returns the customer, or null if it doesn't exist
 */
async function getCustomer(id: string): Promise<Customer | null> {
    try {
        const { customer } = await client.customers.get({ customerId: id });
        return customer?.id
            ? mapSquareCustomer(customer as typeof customer & { id: string })
            : null;
    } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
    }
}

/**
 * Creates a customer in Square.
 * @param input the customer's details
 * @returns the created customer
 */
async function createCustomer(input: CustomerInput): Promise<Customer> {
    const { customer } = await client.customers.create(
        toSquareCreateBody(input, crypto.randomUUID()),
    );
    if (!customer?.id) throw new Error("Square did not return a customer");
    return mapSquareCustomer(customer as typeof customer & { id: string });
}

/**
 * Updates a customer in Square.
 * @param id the customer id
 * @param input the customer's new details
 * @returns the updated customer, or null if it doesn't exist
 */
async function updateCustomer(
    id: string,
    input: CustomerInput,
): Promise<Customer | null> {
    try {
        const { customer: current } = await client.customers.get({
            customerId: id,
        });
        if (!canWriteTags(current?.referenceId) && input.tags.length > 0) {
            logger.debug(
                `customer ${id}: foreign referenceId, tags stay local`,
            );
        }
        const { customer } = await client.customers.update(
            toSquareUpdateBody(id, input, current?.referenceId),
        );
        return customer?.id
            ? mapSquareCustomer(customer as typeof customer & { id: string })
            : null;
    } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
    }
}

/**
 * Deletes a customer in Square.
 * @param id the customer id
 * @returns true if a customer was deleted, false if it didn't exist
 */
async function deleteCustomer(id: string): Promise<boolean> {
    try {
        await client.customers.delete({ customerId: id });
        return true;
    } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
    }
}

export const squareProvider: CatalogProvider &
    PaymentProvider &
    DevicePairingProvider &
    CustomerProvider = {
    listCustomers,
    getCustomer,
    createCustomer,
    updateCustomer,
    deleteCustomer,
    fetchCustomers,
    fetchCatalog,
    fetchLocations,
    createOrder,
    fetchOrder,
    createTerminalCheckout,
    getTerminalCheckoutStatus,
    payCash,
    confirmMobileReaderPayment,
    createDeviceCode,
    getDeviceCode,
};
