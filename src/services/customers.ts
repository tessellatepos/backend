import type {
    Address,
    Customer,
    CustomerInput,
    CustomerPage,
    CustomerQuery,
} from "@tessellatepos/sdk";
import { customerStore, searchCustomers } from "@/services/db/customers";
import { getActiveProvider } from "@/services/providers";

/**
 * Thrown for customer input that fails validation. Messages name the field
 * and the rule, never the value, since customers are PII.
 */
export class CustomerValidationError extends Error {
    readonly issues: string[];

    constructor(issues: string[]) {
        super(`Invalid customer: ${issues.join("; ")}`);
        this.name = "CustomerValidationError";
        this.issues = issues;
    }
}

const MAX_NAME = 100;
const MAX_EMAIL = 254;
const MAX_PHONE = 30;
const MAX_NOTE = 2000;
const MAX_TAGS = 20;
const MAX_TAG = 50;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_SHAPE = /^\+?[\d\s().-]*\d[\d\s().-]*$/;

/**
 * Validates and normalises customer input from an untrusted caller: strings
 * are trimmed, tags de-duplicated, and unknown keys dropped.
 * @param raw the unvalidated input
 * @returns the clean input
 * @throws CustomerValidationError listing every problem found
 */
export function validateCustomerInput(raw: unknown): CustomerInput {
    const issues: string[] = [];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new CustomerValidationError(["body must be an object"]);
    }
    const body = raw as Record<string, unknown>;

    const text = (field: string, max: number): string => {
        const value = body[field];
        if (value === undefined || value === null) return "";
        if (typeof value !== "string") {
            issues.push(`${field} must be a string`);
            return "";
        }
        const trimmed = value.trim();
        if (trimmed.length > max) {
            issues.push(`${field} must be at most ${max} characters`);
        }
        return trimmed;
    };

    const given_name = text("given_name", MAX_NAME);
    const family_name = text("family_name", MAX_NAME);
    const company_name = text("company_name", MAX_NAME);
    const email = text("email", MAX_EMAIL);
    const phone_number = text("phone_number", MAX_PHONE);
    const note = text("note", MAX_NOTE);
    const birthday = text("birthday", 10);

    if (email && !EMAIL_SHAPE.test(email)) issues.push("email is not valid");
    if (phone_number && !PHONE_SHAPE.test(phone_number)) {
        issues.push("phone_number is not valid");
    }
    if (birthday) {
        const date = new Date(`${birthday}T00:00:00Z`);
        const real =
            /^\d{4}-\d{2}-\d{2}$/.test(birthday) &&
            !Number.isNaN(date.getTime()) &&
            date.toISOString().startsWith(birthday);
        if (!real) issues.push("birthday must be a YYYY-MM-DD date");
    }
    if (
        !given_name &&
        !family_name &&
        !company_name &&
        !email &&
        !phone_number
    ) {
        issues.push("a name, company, email or phone_number is required");
    }

    let tags: string[] = [];
    if (body.tags !== undefined && body.tags !== null) {
        if (
            !Array.isArray(body.tags) ||
            !body.tags.every((tag) => typeof tag === "string")
        ) {
            issues.push("tags must be an array of strings");
        } else {
            tags = [...new Set(body.tags.map((tag) => tag.trim()))].filter(
                Boolean,
            );
            if (tags.length > MAX_TAGS) {
                issues.push(`tags must have at most ${MAX_TAGS} entries`);
            }
            if (tags.some((tag) => tag.length > MAX_TAG)) {
                issues.push(`each tag must be at most ${MAX_TAG} characters`);
            }
        }
    }

    let address: Address | undefined;
    if (body.address !== undefined && body.address !== null) {
        const a = body.address as Record<string, unknown>;
        if (
            typeof a !== "object" ||
            Array.isArray(a) ||
            typeof a.country !== "string" ||
            typeof a.address_line_1 !== "string"
        ) {
            issues.push("address needs a country and address_line_1");
        } else {
            address = body.address as Address;
        }
    }

    if (issues.length > 0) throw new CustomerValidationError(issues);
    return {
        given_name,
        family_name,
        company_name,
        email,
        phone_number,
        address,
        birthday: birthday || undefined,
        note,
        tags,
    };
}

/**
 * Creates a customer: validates, writes to the active provider, then mirrors
 * what the provider stored into Postgres.
 * @param raw the unvalidated input
 * @returns the created customer
 */
export async function createCustomer(raw: unknown): Promise<Customer> {
    const created = await getActiveProvider().createCustomer(
        validateCustomerInput(raw),
    );
    await customerStore.upsert(created);
    return (await customerStore.get(created.id)) ?? created;
}

/**
 * Updates a customer: validates, writes to the active provider, then mirrors
 * the result into Postgres.
 * @param id the customer id
 * @param raw the unvalidated new details
 * @returns the updated customer, or null if it doesn't exist
 */
export async function updateCustomer(
    id: string,
    raw: unknown,
): Promise<Customer | null> {
    const updated = await getActiveProvider().updateCustomer(
        id,
        validateCustomerInput(raw),
    );
    if (!updated) {
        // gone upstream: drop the stale mirror row
        await customerStore.remove(id);
        return null;
    }
    await customerStore.upsert(updated);
    return (await customerStore.get(id)) ?? updated;
}

/**
 * Deletes a customer from the active provider, then from Postgres.
 * @param id the customer id
 * @returns true if the customer existed in the provider or in Postgres
 */
export async function deleteCustomer(id: string): Promise<boolean> {
    const deletedUpstream = await getActiveProvider().deleteCustomer(id);
    const deletedLocally = await customerStore.remove(id);
    return deletedUpstream || deletedLocally;
}

/**
 * Fetches a customer from Postgres.
 * @param id the customer id
 * @returns the customer, or null if it doesn't exist
 */
export async function getCustomer(id: string): Promise<Customer | null> {
    return customerStore.get(id);
}

/**
 * Searches customers in Postgres.
 * @param query text search, filters and paging
 * @returns a page of customers
 */
export async function findCustomers(
    query: CustomerQuery = {},
): Promise<CustomerPage> {
    return searchCustomers(query);
}
