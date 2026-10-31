import express, { Router } from "express";
import { Logger } from "tslog";
import {
    getActiveProviderId,
    isProviderId,
    providerInfo,
    setActiveProvider,
} from "@/services/providers";
import { updateCatalogInCache } from "@/services/catalogSync";
import { requireScope } from "@/middleware/authenticate";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";

const configProviderRouter: Router = express.Router();

const logger = new Logger();

export const configProviderv1Endpoint: ITessellateApiRouter = {
    route_path: "/config/provider",
    version: "v1",
    router: configProviderRouter,
};

/** @returns the active provider, what it can do, and the choices offered */
function describeProvider() {
    const active = getActiveProviderId();
    return {
        active,
        info: providerInfo[active],
        available: Object.keys(providerInfo),
    };
}

configProviderRouter.get("/", requireScope("settings:read"), (_req, res) => {
    res.json(describeProvider());
});

// Switching changes how orders are paid and where the catalog comes from, so
// only an owner (settings:admin) may do it.
configProviderRouter.post(
    "/",
    requireScope("settings:admin"),
    async (req, res) => {
        const provider = req.body?.provider;
        if (!isProviderId(provider)) {
            res.status(400).json({ message: "Unknown provider" });
            return;
        }

        try {
            await setActiveProvider(provider);
        } catch (err) {
            logger.error("Failed to switch provider", err);
            res.status(500).json({ message: "Failed to switch provider" });
            return;
        }

        // The new provider may expose a different catalog; a failed sync (e.g.
        // Square not connected yet) must not undo the switch.
        let syncError: string | undefined;
        try {
            await updateCatalogInCache();
        } catch (err) {
            logger.warn("Catalog sync after provider switch failed:", err);
            syncError = "Switched, but the catalog sync failed.";
        }

        res.json({ ...describeProvider(), syncError });
    },
);
