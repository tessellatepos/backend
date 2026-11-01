import { readFileSync } from "node:fs";
import path from "node:path";
import type { CountryCode, CurrencyCode, ProviderId } from "@tessellatepos/sdk";
import { Logger } from "tslog";
import { createLocalDevice } from "@/services/db/configDevice";
import { importCatalogCsv } from "@/services/db/catalogImport";
import { listItems } from "@/services/db/catalogManage";
import { createLocalLocation } from "@/services/db/locations";
import { setActiveProvider, visibleCatalogScope } from "@/services/providers";
import { completeSetup, createOwner, hasUsers } from "@/services/setup";

const logger = new Logger();

/** Default owner credentials. Development only. */
export const DEV_SEED_USERNAME = "admin";
export const DEV_SEED_PASSWORD = "password";

/**
 * The demo catalog, sold at "Test Store". Lives beside this module's parent
 * in src/seed, and the build copies it to dist/seed.
 */
export const DEV_SEED_CATALOG_PATH = path.join(
    __dirname,
    "..",
    "seed",
    "demo-catalog.csv",
);

/** The env vars the seed reads. Passed in so the seed is testable. */
export interface DevSeedEnv {
    NODE_ENV?: string;
    DEV_SEED?: string;
    SETUP_TOKEN?: string;
    PUBLIC_URL?: string;
}

/** Side effects the seed performs, passed in so tests can replace them. */
export interface DevSeedDeps {
    hasUsers(): Promise<boolean>;
    createOwner(body: Record<string, unknown>): Promise<unknown>;
    createLocation(input: {
        name: string;
        currency: CurrencyCode;
        country: CountryCode;
    }): Promise<{ id: string }>;
    createDevice(locationId: string): Promise<unknown>;
    setProvider(id: ProviderId): Promise<void>;
    /** Items the catalog holds, as the active provider counts them. */
    countCatalogItems(): Promise<number>;
    /** Imports the demo catalog; resolves true when the import was applied. */
    importDemoCatalog(): Promise<boolean>;
    completeSetup(): Promise<void>;
    log: {
        info(...args: unknown[]): void;
        warn(...args: unknown[]): void;
        error(...args: unknown[]): void;
    };
}

/**
 * What happened on this startup:
 * disabled (DEV_SEED not "true"), refused (a safety rule), skipped (a user
 * already exists), seeded, or failed (an error was logged).
 */
export type DevSeedOutcome =
    "disabled" | "refused" | "skipped" | "seeded" | "failed";

/** The production wiring of {@link DevSeedDeps}. */
export const devSeedDeps: DevSeedDeps = {
    hasUsers,
    // No setup token: the seed refuses to run when SETUP_TOKEN is set.
    createOwner: (body) => createOwner(undefined, body),
    createLocation: createLocalLocation,
    createDevice: (locationId) => createLocalDevice(locationId),
    setProvider: setActiveProvider,
    countCatalogItems: async () =>
        (
            await listItems(
                { limit: 1, offset: 0, archived: "all" },
                visibleCatalogScope(),
                { allowedLocations: "all" },
            )
        ).total,
    importDemoCatalog: async () =>
        (
            await importCatalogCsv(
                readFileSync(DEV_SEED_CATALOG_PATH, "utf8"),
                { dryRun: false },
                { allowedLocations: "all" },
            )
        ).applied,
    completeSetup,
    log: logger,
};

/**
 * Why the seed must not run, if it must not.
 * @param env the environment the seed was started with
 * @returns the reason, or null when the seed may run
 */
export function refusalReason(env: DevSeedEnv): string | null {
    if (env.NODE_ENV === "production") return "NODE_ENV is production";
    if (env.SETUP_TOKEN?.trim()) return "SETUP_TOKEN is set";
    if (env.PUBLIC_URL?.trim()) return "PUBLIC_URL is set";
    return null;
}

/**
 * Development only. With DEV_SEED=true and an empty user table, creates the
 * owner admin / password, a "Test Store" with a LOCAL till, the local
 * provider, the demo catalog (when the catalog is empty), and marks setup
 * complete, so the instance goes straight to
 * sign-in. Does nothing once any user exists. Refuses (logs an error and
 * changes nothing) under NODE_ENV=production or alongside SETUP_TOKEN or
 * PUBLIC_URL.
 * @param env the environment, normally process.env
 * @param deps the side effects, normally {@link devSeedDeps}
 * @returns what happened; never throws
 */
export async function runDevSeed(
    env: DevSeedEnv,
    deps: DevSeedDeps = devSeedDeps,
): Promise<DevSeedOutcome> {
    if (env.DEV_SEED?.trim().toLowerCase() !== "true") return "disabled";

    const refusal = refusalReason(env);
    if (refusal) {
        deps.log.error(
            `DEV_SEED refused: ${refusal}. No account was created. Unset DEV_SEED.`,
        );
        return "refused";
    }

    try {
        if (await deps.hasUsers()) return "skipped";

        await deps.createOwner({
            name: "Admin",
            username: DEV_SEED_USERNAME,
            email: "admin@example.test",
            password: DEV_SEED_PASSWORD,
        });
        const location = await deps.createLocation({
            name: "Test Store",
            currency: "CAD",
            country: "CA",
        });
        await deps.createDevice(location.id);
        await deps.setProvider("local");
        // Only into an empty catalog, so a re-seed never duplicates rows.
        if ((await deps.countCatalogItems()) === 0) {
            if (!(await deps.importDemoCatalog())) {
                throw new Error("the demo catalog import was rejected");
            }
        }
        await deps.completeSetup();
    } catch (err) {
        deps.log.error(
            "DEV_SEED failed; the database may be partly set up. Reset it before retrying.",
            err,
        );
        return "failed";
    }

    deps.log.warn(
        `DEV_SEED: default credentials ${DEV_SEED_USERNAME} / ${DEV_SEED_PASSWORD} were created. Development only: never run this on a deployed instance.`,
    );
    return "seeded";
}
