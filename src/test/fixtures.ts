import type {
    Customer,
    CustomerInput,
    Item,
    Location,
} from "@tessellatepos/sdk";

/**
 * Builds a location with every optional field unset.
 * @param id the location id
 * @param name the location name
 * @returns the location
 */
export function makeLocation(id: string, name: string): Location {
    return {
        id,
        name,
        address: { country: "CA", address_line_1: `${name} street` },
        currency: "CAD",
        phone_number: "",
        website_url: "",
        email: "",
        hours: {
            sunday: [],
            monday: [],
            tuesday: [],
            wednesday: [],
            thursday: [],
            friday: [],
            saturday: [],
        },
        logo_url: "",
    };
}

/**
 * Builds an item with one variation, one category and the given locations.
 * @param id the item id
 * @param name the item name
 * @param locationIds the locations the item is present at
 * @returns the item, as getCatalogByLocation returns it
 */
export function makeItem(
    id: string,
    name: string,
    locationIds: string[] = [],
): Item {
    return {
        id,
        name,
        displayName: null,
        labelColor: null,
        isTaxable: true,
        isArchived: false,
        image: null,
        variations: [
            {
                itemId: `${id}-v`,
                name: "Regular",
                sku: `${id}-sku`,
                upc: null,
                ordinal: null,
                pricingType: "FIXED",
                priceMoney: { amount: 350n, currency: "CAD" },
                locationOverrides: null,
                trackInventory: false,
                parent: { id, name },
            },
        ],
        categories: [
            {
                id: "cat",
                name: "Drinks",
                parentCategory: null,
                imageId: null,
                imageURL: null,
            },
        ],
        locationIds,
    };
}

/**
 * Builds customer input with the optional fields unset.
 * @param given the given name
 * @param family the family name
 * @param overrides any fields to set
 * @returns the input
 */
export function makeCustomerInput(
    given: string,
    family = "Tester",
    overrides: Partial<CustomerInput> = {},
): CustomerInput {
    return {
        given_name: given,
        family_name: family,
        company_name: "",
        email: "",
        phone_number: "",
        note: "",
        tags: [],
        ...overrides,
    };
}

/**
 * Builds a customer with a fixed id and timestamps.
 * @param id the customer id
 * @param given the given name
 * @param overrides any fields to set
 * @returns the customer
 */
export function makeCustomer(
    id: string,
    given: string,
    overrides: Partial<CustomerInput> = {},
): Customer {
    return {
        ...makeCustomerInput(given, "Tester", overrides),
        id,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
    };
}
