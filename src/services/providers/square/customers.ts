import type {
    Address as SquareAddress,
    Customer as SquareCustomer,
    CreateCustomerRequest,
    UpdateCustomerRequest,
} from "square";
import type {
    Address,
    CountryCode,
    Customer,
    CustomerInput,
    CustomerPage,
    CustomerQuery,
} from "@tessellatepos/sdk";

/**
 * Tags. Square customers have no tags, only groups (which are managed and
 * assigned through separate APIs and are per-seller segments, not free text)
 * and one free `referenceId` string of at most 100 characters. We store the
 * tags there as TAGS_PREFIX + a JSON array. The mapping is lossy in three
 * ways: tags that do not fit in 100 characters are dropped from the end; a
 * referenceId the seller set themselves is never overwritten (see
 * canWriteTags), so that customer's tags stay local-only and read back as
 * "no tags"; and the tags are visible to the seller as a reference id in the
 * Square dashboard. Pure Square-side tags would need
 * custom attributes, which need a per-seller definition to exist first.
 */
const TAGS_PREFIX = "tessellate:tags:";
const REFERENCE_ID_MAX = 100;

/**
 * Whether our tags may be written over a customer's current reference id:
 * only when it is empty or already ours.
 * @param current the customer's current Square referenceId
 * @returns true if writing tags would not clobber a seller's value
 */
export function canWriteTags(current?: string | null): boolean {
    return !current || current.startsWith(TAGS_PREFIX);
}

/**
 * Encodes tags into a Square reference id.
 * @param tags the customer's tags
 * @returns the reference id, or undefined if there is nothing to store
 */
export function tagsToReferenceId(tags: string[]): string | undefined {
    const kept = [...tags];
    while (
        kept.length > 0 &&
        (TAGS_PREFIX + JSON.stringify(kept)).length > REFERENCE_ID_MAX
    ) {
        kept.pop();
    }
    return kept.length > 0 ? TAGS_PREFIX + JSON.stringify(kept) : undefined;
}

/**
 * Decodes tags from a Square reference id.
 * @param referenceId Square's referenceId, if any
 * @returns the tags, or [] if the reference id is not ours
 */
export function referenceIdToTags(referenceId?: string | null): string[] {
    if (!referenceId?.startsWith(TAGS_PREFIX)) return [];
    try {
        const parsed: unknown = JSON.parse(
            referenceId.slice(TAGS_PREFIX.length),
        );
        return Array.isArray(parsed) &&
            parsed.every((tag) => typeof tag === "string")
            ? (parsed as string[])
            : [];
    } catch {
        return [];
    }
}

/**
 * Maps a Square address to an SDK address.
 * @param address the Square address
 * @returns the address, or undefined if it has no content
 */
function mapSquareAddress(address?: SquareAddress): Address | undefined {
    if (!address) return undefined;
    const line2 = [address.addressLine2, address.addressLine3]
        .filter(Boolean)
        .join(", ");
    const mapped: Address = {
        // Square can omit the country; the SDK requires one.
        country: (address.country ?? "") as CountryCode,
        address_line_1: address.addressLine1 ?? "",
        address_line_2: line2 || undefined,
        dependent_locality: address.sublocality || undefined,
        locality: address.locality || undefined,
        subdivision: address.administrativeDistrictLevel1 || undefined,
        postal_code: address.postalCode || undefined,
    };
    if (!Object.values(mapped).some(Boolean)) return undefined;
    // drop unset keys so the address matches one that came back from JSON
    return JSON.parse(JSON.stringify(mapped)) as Address;
}

/**
 * Maps an SDK address to a Square address.
 * @param address the SDK address
 * @returns the Square address, or undefined if there is none
 */
function toSquareAddress(address?: Address): SquareAddress | undefined {
    if (!address) return undefined;
    return {
        addressLine1: address.address_line_1 || undefined,
        addressLine2: address.address_line_2 || undefined,
        sublocality: address.dependent_locality || undefined,
        locality: address.locality || undefined,
        administrativeDistrictLevel1: address.subdivision || undefined,
        postalCode: address.postal_code || undefined,
        country: (address.country || undefined) as SquareAddress["country"],
    };
}

/**
 * Maps a Square customer to a Customer. Square's nickname, preferences,
 * groups, segments and tax ids have no SDK counterpart and are dropped.
 * @param customer the Square customer, which must have an id
 * @returns the customer
 */
export function mapSquareCustomer(
    customer: SquareCustomer & { id: string },
): Customer {
    return {
        id: customer.id,
        given_name: customer.givenName ?? "",
        family_name: customer.familyName ?? "",
        company_name: customer.companyName ?? "",
        email: customer.emailAddress ?? "",
        phone_number: customer.phoneNumber ?? "",
        address: mapSquareAddress(customer.address),
        birthday: customer.birthday || undefined,
        note: customer.note ?? "",
        tags: referenceIdToTags(customer.referenceId),
        created_at: customer.createdAt ?? "",
        updated_at: customer.updatedAt ?? "",
    };
}

/**
 * Builds a Square create body. Empty fields are omitted.
 * @param input the customer's details
 * @param idempotencyKey a key unique to this create
 * @returns the request body
 */
export function toSquareCreateBody(
    input: CustomerInput,
    idempotencyKey: string,
): CreateCustomerRequest {
    return {
        idempotencyKey,
        givenName: input.given_name || undefined,
        familyName: input.family_name || undefined,
        companyName: input.company_name || undefined,
        emailAddress: input.email || undefined,
        phoneNumber: input.phone_number || undefined,
        address: toSquareAddress(input.address),
        birthday: input.birthday || undefined,
        note: input.note || undefined,
        referenceId: tagsToReferenceId(input.tags),
    };
}

/**
 * Builds a Square update body. Square leaves omitted fields alone and clears
 * fields sent as null, so empty fields are sent as null to make the update
 * replace the customer's details. An address cannot be cleared this way and
 * is only sent when set. The referenceId is only written when it is empty
 * or already holds our tags; a seller's own value is left out (untouched).
 * @param id the customer id
 * @param input the customer's new details
 * @param currentReferenceId the customer's current Square referenceId
 * @returns the request body
 */
export function toSquareUpdateBody(
    id: string,
    input: CustomerInput,
    currentReferenceId?: string | null,
): UpdateCustomerRequest {
    return {
        customerId: id,
        givenName: input.given_name || null,
        familyName: input.family_name || null,
        companyName: input.company_name || null,
        emailAddress: input.email || null,
        phoneNumber: input.phone_number || null,
        address: toSquareAddress(input.address),
        birthday: input.birthday || null,
        note: input.note || null,
        ...(canWriteTags(currentReferenceId)
            ? { referenceId: tagsToReferenceId(input.tags) ?? null }
            : {}),
    };
}

/**
 * Filters and pages customers in memory. Square's search cannot match text
 * across names, email and phone, so list queries are answered from the full
 * list. Pages are ordered by id and the cursor is the last id returned.
 * @param customers every customer
 * @param query text search, filters and paging
 * @returns a page of customers
 */
export function pageCustomers(
    customers: Customer[],
    query: CustomerQuery,
): CustomerPage {
    const text = query.text?.toLowerCase();
    const matches = customers
        .filter((c) => {
            if (
                query.email &&
                c.email.toLowerCase() !== query.email.toLowerCase()
            )
                return false;
            if (query.phone_number && c.phone_number !== query.phone_number)
                return false;
            if (query.tag && !c.tags.includes(query.tag)) return false;
            if (!text) return true;
            return [
                c.given_name,
                c.family_name,
                c.company_name,
                c.email,
                c.phone_number,
            ].some((field) => field.toLowerCase().includes(text));
        })
        .sort((a, b) => a.id.localeCompare(b.id))
        .filter((c) => !query.cursor || c.id > query.cursor);
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 200);
    const page = matches.slice(0, limit);
    return {
        customers: page,
        next_cursor: matches.length > limit ? page[page.length - 1].id : null,
    };
}
