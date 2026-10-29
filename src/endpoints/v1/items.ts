import express from "express";
import { Request, Response, Router } from "express";
import { getItemsByLocationID } from "@/services/redis";
import { getConfigDeviceByID } from "@/services/db/configDevice";
import { type Item } from "@tessellatepos/sdk";
import { Logger } from "tslog";
import { updateCatalogInCache } from "@/services/catalogSync";
import { getParamValue } from "@/utils/expressHelpers";
import { requireLocation, requireScope } from "@/middleware/authenticate";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";

const itemRouter: Router = express.Router();

const logger = new Logger();

export const itemsv1Endpoint: ITessellateApiRouter = {
    route_path: "/items",
    version: "v1",
    router: itemRouter,
};

// itemRouter.get("/items/:itemId", async (req: Request, res: Response) => {});

itemRouter.get(
    "/by-device-id/:deviceId",
    requireScope("catalog:read"),
    async (req: Request, res: Response) => {
        const deviceId = getParamValue(req.params.deviceId);

        if (!deviceId || deviceId === "undefined") {
            res.status(400).json({
                message: "Invalid deviceID",
            });
            return;
        }

        const deviceConfig = await getConfigDeviceByID(deviceId);
        if (!deviceConfig) {
            res.status(404).json({
                message: "Device configuration not found",
            });
            return;
        }

        const locationId = deviceConfig.square_location;
        if (!locationId) {
            res.status(400).json({
                message: "Device has no associated location",
            });
            return;
        }

        let items: Item[] = [];
        const fetched = await getItemsByLocationID(locationId);
        if (Array.isArray(fetched)) items = fetched;

        res.json(items);
    },
);

itemRouter.get(
    "/by-location/",
    requireScope("catalog:read"),
    async (req: Request, res: Response) => {
        let items: Item[] = [];

        logger.debug(
            "No locationID provided, fetching items for all locations.",
        );
        const fetched = await getItemsByLocationID();
        if (Array.isArray(fetched)) items = fetched;

        res.json(items);

        // Placeholder: implement logic to return items for a specific location when locationID is set,
        // or return items across all locations (or apply a default) when locationID is undefined.
        // For now, respond with a simple JSON to show behavior.
        // res.json({ locationID: locationID ?? null, message: locationID ? "Filtered by location" : "No location provided - returning default/all items" });
    },
);

itemRouter.get(
    "/by-location/:locationId",
    requireScope("catalog:read"),
    requireLocation((req) => req.params.locationId as string),
    async (req: Request<{ locationId: string }>, res: Response) => {
        const locationId = req.params.locationId;

        if (!locationId || locationId === "undefined") {
            res.status(400).json({
                message: "Invalid locationID",
            });
            return;
        }

        let items: Item[] = [];

        if (!locationId) {
            logger.warn("No locationID provided, error fetching items");
        } else {
            items = items.concat(await getItemsByLocationID(locationId));
        }

        res.json(items);

        // Placeholder: implement logic to return items for a specific location when locationID is set,
        // or return items across all locations (or apply a default) when locationID is undefined.
        // For now, respond with a simple JSON to show behavior.
        // res.json({ locationID: locationID ?? null, message: locationID ? "Filtered by location" : "No location provided - returning default/all items" });
    },
);

// itemRouter.get("/items/variations/by-id", async (req: Request, res: Response) => {});

itemRouter.get(
    "/update/",
    requireScope("catalog:write"),
    async (req: Request, res: Response) => {
        await updateCatalogInCache();
        res.json({ message: "Catalog update triggered" });
    },
);
