import { and, eq, sql, type SQL } from "drizzle-orm";
import type {
    Address,
    Customer,
    CustomerPage,
    CustomerQuery,
} from "@tessellatepos/sdk";
import { createLocalStore, emptyIfNull, nullIfEmpty } from "@/services/store";
import { customersTable } from "./schema";

/** Page size when a query has no limit, and the most one page may return. */
export const DEFAULT_CUSTOMER_PAGE_SIZE = 50;
export const MAX_CUSTOMER_PAGE_SIZE = 200;

/**
 * Converts a persisted customers row back into a Customer.
 * @param row the persisted customer row
 * @returns the customer
 */
function rowToCustomer(row: typeof customersTable.$inferSelect): Customer {
    return {
        id: row.id,
        given_name: emptyIfNull(row.givenName),
        family_name: emptyIfNull(row.familyName),
        company_name: emptyIfNull(row.companyName),
        email: emptyIfNull(row.email),
        phone_number: emptyIfNull(row.phoneNumber),
        address: (row.address as Address | null) ?? undefined,
        birthday: row.birthday ?? undefined,
        note: emptyIfNull(row.note),
        tags: (row.tags as string[] | null) ?? [],
        created_at: (row.createdAt ?? new Date()).toISOString(),
        updated_at: (row.updatedAt ?? new Date()).toISOString(),
    };
}

/**
 * Converts a Customer into a customers row.
 * @param customer the customer
 * @returns the row to persist
 */
function customerToRow(customer: Customer): typeof customersTable.$inferInsert {
    const provider = process.env.PROVIDER === "local" ? "local" : "square";
    return {
        id: customer.id,
        givenName: nullIfEmpty(customer.given_name),
        familyName: nullIfEmpty(customer.family_name),
        companyName: nullIfEmpty(customer.company_name),
        email: nullIfEmpty(customer.email),
        phoneNumber: nullIfEmpty(customer.phone_number),
        address: customer.address ?? null,
        birthday: nullIfEmpty(customer.birthday),
        note: nullIfEmpty(customer.note),
        tags: customer.tags,
        provider,
        providerId: customer.id,
        createdAt: new Date(customer.created_at),
    };
}

/**
 * The persisted customers, whichever provider supplied them. Customers are
 * hard deleted, including those a provider stops returning (syncResource). Rows hold PII:
 * never log their fields.
 */
export const customerStore = createLocalStore({
    table: customersTable,
    toRow: customerToRow,
    fromRow: rowToCustomer,
    searchColumns: [
        customersTable.givenName,
        customersTable.familyName,
        customersTable.companyName,
        customersTable.email,
        customersTable.phoneNumber,
    ],
});

/**
 * Searches the persisted customers. Email matches case-insensitively and
 * phone number exactly; both filters and the tag filter are ANDed with the
 * text search.
 * @param query the search text, filters and paging
 * @returns a page of customers, ordered by id
 */
export async function searchCustomers(
    query: CustomerQuery = {},
): Promise<CustomerPage> {
    const filters: SQL[] = [];
    if (query.email) {
        filters.push(
            sql`lower(${customersTable.email}) = ${query.email.toLowerCase()}`,
        );
    }
    if (query.phone_number) {
        filters.push(eq(customersTable.phoneNumber, query.phone_number));
    }
    if (query.tag) {
        filters.push(
            sql`${customersTable.tags} @> ${JSON.stringify([query.tag])}::jsonb`,
        );
    }
    const limit = Math.min(
        Math.max(Math.floor(query.limit ?? DEFAULT_CUSTOMER_PAGE_SIZE), 1),
        MAX_CUSTOMER_PAGE_SIZE,
    );
    const page = await customerStore.list({
        text: query.text,
        limit,
        cursor: query.cursor,
        where: and(...filters),
    });
    return { customers: page.items, next_cursor: page.nextCursor };
}
