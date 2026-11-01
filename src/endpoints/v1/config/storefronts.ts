import express, { Router } from "express";
import { Logger } from "tslog";
import { CURRENCIES, COUNTRIES } from "@tessellatepos/sdk";
import type { CountryCode, CurrencyCode } from "@tessellatepos/sdk";
import { getActiveProviderId, providerInfo } from "@/services/providers";
import {
    createLocalLocation,
    getLocationById,
    getLocations,
    removeLocalStorefront,
    removeLocation,
} from "@/services/db/locations";
import { createLocalDevice, getLocalDevices } from "@/services/db/configDevice";
import { getParamValue } from "@/utils/expressHelpers";
import { requireScope } from "@/middleware/authenticate";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";

const storefrontRouter: Router = express.Router();

const logger = new Logger();

export const configStorefrontsv1Endpoint: ITessellateApiRouter = {
    route_path: "/config/storefronts",
    version: "v1",
    router: storefrontRouter,
};

// Lists the persisted locations (the same data as /locations), with whether
// this provider lets the owner manage them. Each carries the id of its LOCAL
// till as deviceId, or null when it has none.
storefrontRouter.get("/", requireScope("settings:read"), async (_req, res) => {
    try {
        const info = providerInfo[getActiveProviderId()];
        const locations = await getLocations();
        const tillByLocation = new Map(
            (await getLocalDevices()).map((d) => [d.square_location, d.id]),
        );
        const storefronts = locations.map((location) => ({
            ...location,
            deviceId: tillByLocation.get(location.id) ?? null,
        }));
        res.json({ canManage: info.canManageStorefronts, storefronts });
    } catch (err) {
        logger.error("Failed to list storefronts", err);
        res.status(500).json({ message: "Failed to list storefronts" });
    }
});

storefrontRouter.post("/", requireScope("settings:admin"), async (req, res) => {
    if (!providerInfo[getActiveProviderId()].canManageStorefronts) {
        res.status(400).json({
            message: "The active provider does not allow creating storefronts",
        });
        return;
    }

    const { name, currency, country } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
        res.status(400).json({ message: "A name is required" });
        return;
    }
    if (!isKey(CURRENCIES, currency)) {
        res.status(400).json({ message: "Unknown currency" });
        return;
    }
    if (!isKey(COUNTRIES, country)) {
        res.status(400).json({ message: "Unknown country" });
        return;
    }

    try {
        const storefront = await createLocalLocation({
            name: name.trim(),
            currency: currency as CurrencyCode,
            country: country as CountryCode,
        });
        // The storefront and its till go together. The helpers take no
        // transaction, so a failed till creation soft deletes the new
        // location again; it then never shows in any list.
        let till;
        try {
            till = await createLocalDevice(storefront.id);
        } catch (err) {
            logger.error("Failed to create till, removing the storefront", err);
            await removeLocation(storefront.id);
            throw err;
        }
        res.status(201).json({ ...storefront, deviceId: till.id });
    } catch (err) {
        logger.error("Failed to create storefront", err);
        res.status(500).json({ message: "Failed to create storefront" });
    }
});

storefrontRouter.delete(
    "/:id",
    requireScope("settings:admin"),
    async (req, res) => {
        if (!providerInfo[getActiveProviderId()].canManageStorefronts) {
            res.status(400).json({
                message:
                    "The active provider does not allow deleting storefronts",
            });
            return;
        }

        const id = getParamValue(req.params.id);
        if (!id || !(await getLocationById(id))) {
            res.status(404).json({ message: "Storefront not found" });
            return;
        }

        // Only locally-created storefronts are removable; synced Square
        // locations would just reappear on the next sync.
        if (!id.startsWith("local-")) {
            res.status(400).json({
                message: "Only local storefronts can be deleted",
            });
            return;
        }

        // Removes the storefront and its till in one transaction.
        await removeLocalStorefront(id);
        res.json({ message: "Storefront deleted" });
    },
);

/**
 * Whether a value is a key of a reference table. Own keys only, so that
 * "constructor" and similar names are not accepted.
 * @param table the reference table
 * @param value the candidate from the request body
 * @returns true for a listed key
 */
function isKey(table: object, value: unknown): boolean {
    return typeof value === "string" && Object.hasOwn(table, value);
}
