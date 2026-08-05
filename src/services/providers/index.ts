import { squareProvider } from "./square";
import { localProvider } from "./local";
import type { CatalogProvider, PaymentProvider } from "./types";

/**
 * The provider this deployment runs against, chosen once at startup from
 * PROVIDER. Defaults to Square; set PROVIDER=local for a cash-only demo
 * with no external payment processor.
 */
export const activeProvider: CatalogProvider & PaymentProvider =
    process.env.PROVIDER === "local" ? localProvider : squareProvider;
