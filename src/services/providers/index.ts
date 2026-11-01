import { squareProvider } from "./square";
import { localProvider } from "./local";
import type {
    CatalogProvider,
    PaymentProvider,
    DevicePairingProvider,
} from "./types";

/**
 * Which provider this deployment runs against, from PROVIDER. Read on each
 * call so it always agrees with {@link activeProvider}'s selection rule.
 * @returns "local" when PROVIDER=local, otherwise "square"
 */
export function activeProviderName(): "local" | "square" {
    return process.env.PROVIDER === "local" ? "local" : "square";
}

/**
 * The provider this deployment runs against, chosen once at startup from
 * PROVIDER. Defaults to Square; set PROVIDER=local for a cash-only demo
 * with no external payment processor.
 */
export const activeProvider: CatalogProvider &
    PaymentProvider &
    DevicePairingProvider =
    activeProviderName() === "local" ? localProvider : squareProvider;
