import type { Location } from "@tessellatepos/sdk";

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
