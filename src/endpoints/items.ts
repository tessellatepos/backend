import express from "express";
import { Request, Response, Router } from "express";
import { getItemsByLocationID } from "../services/redis";
import { squareItem } from "@tessellate-pos/common/src/types/squareTypes";
import { Logger } from "tslog";
import { updateCatalogInCache } from "../server";

export const itemRouter: Router = express.Router();

const logger = new Logger();

// itemRouter.get("/items/:itemId", async (req: Request, res: Response) => {});

itemRouter.get("/by-location/", async (req: Request, res: Response) => {
    let items: squareItem[] = [];

    logger.debug("No locationID provided, fetching items for all locations.");
    const fetched = await getItemsByLocationID();
    if (Array.isArray(fetched)) items = fetched;

    res.json(items);

    // Placeholder: implement logic to return items for a specific location when locationID is set,
    // or return items across all locations (or apply a default) when locationID is undefined.
    // For now, respond with a simple JSON to show behavior.
    // res.json({ locationID: locationID ?? null, message: locationID ? "Filtered by location" : "No location provided - returning default/all items" });
});

itemRouter.get(
    "/by-location/:locationID",
    async (req: Request, res: Response) => {
        const locationID = req.params.locationID;
        let items: squareItem[] = [];

        if (!locationID) {
            logger.warn("No locationID provided, error fetching items");
        } else if (Array.isArray(locationID)) {
            for (const id in locationID) {
                items = items.concat(await getItemsByLocationID(id));
            }
        } else {
            items = items.concat(await getItemsByLocationID(locationID));
        }

        res.json(items);

        // Placeholder: implement logic to return items for a specific location when locationID is set,
        // or return items across all locations (or apply a default) when locationID is undefined.
        // For now, respond with a simple JSON to show behavior.
        // res.json({ locationID: locationID ?? null, message: locationID ? "Filtered by location" : "No location provided - returning default/all items" });
    },
);

// itemRouter.get("/items/variations/by-id", async (req: Request, res: Response) => {});

itemRouter.get("/update/", async (req: Request, res: Response) => {
    await updateCatalogInCache();
    res.json({ message: "Catalog update triggered" });
});
