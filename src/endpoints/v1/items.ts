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
import {
    itemListQuerySchema,
    itemPageSchema,
    itemSchema,
    itemSearchQuerySchema,
} from "@/gateway/schemas/catalog";
import {
    InvalidCursorError,
    cachedItemsFor,
    inCategory,
    matchesText,
    onlineItems,
    pageOf,
    readPaging,
} from "@/services/onlineCatalog";

const itemRouter: Router = express.Router();

const logger = new Logger();

/** How long a store may reuse an online catalog answer without asking again. */
const ONLINE_CATALOG_MAX_AGE = 60;

/**
 * Runs an online-catalog handler, answering a bad cursor with 400.
 * @param fn the handler
 * @returns the Express handler
 */
function online(
    fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => Promise<void> {
    return async (req, res) => {
        try {
            await fn(req, res);
        } catch (err) {
            if (err instanceof InvalidCursorError) {
                res.status(400).json({ message: "Invalid cursor" });
                return;
            }
            logger.error("Online catalog request failed:", err);
            res.status(500).json({ message: "Failed to read the catalog" });
        }
    };
}

/** @returns the first value of a query parameter that is a string */
function queryText(value: unknown): string | undefined {
    return typeof value === "string" && value ? value : undefined;
}

function sendPage(res: Response, page: ReturnType<typeof pageOf<Item>>): void {
    res.json({ items: page.items, next_cursor: page.nextCursor });
}

export const itemsv1Endpoint: ITessellateApiRouter = {
    route_path: "/items",
    version: "v1",
    router: itemRouter,
    gateway: [
        {
            method: "GET",
            path: "/",
            internalPath: "/online/",
            operationId: "items.list",
            scope: "catalog:read",
            summary:
                "List the items sold online at the credential's locations, one page at a time",
            location: "none",
            request: itemListQuerySchema,
            response: itemPageSchema,
            cacheSeconds: ONLINE_CATALOG_MAX_AGE,
        },
        {
            method: "GET",
            path: "/search",
            internalPath: "/online/search",
            operationId: "items.search",
            scope: "catalog:read",
            summary:
                "Search the online items by name, display name, variation name or SKU",
            location: "none",
            request: itemSearchQuerySchema,
            response: itemPageSchema,
            cacheSeconds: ONLINE_CATALOG_MAX_AGE,
        },
        {
            method: "GET",
            path: "/by-id/:itemId",
            internalPath: "/online/by-id/:itemId",
            operationId: "items.get",
            scope: "catalog:read",
            summary: "Get one item sold online at the credential's locations",
            location: "none",
            response: itemSchema,
            cacheSeconds: ONLINE_CATALOG_MAX_AGE,
        },
        {
            method: "GET",
            path: "/:locationId",
            internalPath: "/online/at/:locationId",
            operationId: "items.listAtLocation",
            scope: "catalog:read",
            summary:
                "List the items sold online at one location, one page at a time",
            location: "path",
            request: itemListQuerySchema,
            response: itemPageSchema,
            cacheSeconds: ONLINE_CATALOG_MAX_AGE,
        },
    ],
};

// The online catalog: items sold on the "online" channel at the principal's
// locations, in id order, paged by cursor. The gateway serves these.
itemRouter.get(
    "/online/",
    requireScope("catalog:read"),
    online(async (req, res) => {
        const paging = readPaging(req.query);
        const categoryId = queryText(req.query.category_id);
        const items = (
            await onlineItems(req.principal?.location_ids ?? [])
        ).filter((item) => !categoryId || inCategory(item, categoryId));
        sendPage(res, pageOf(items, paging));
    }),
);

itemRouter.get(
    "/online/search",
    requireScope("catalog:read"),
    online(async (req, res) => {
        const paging = readPaging(req.query);
        const text = queryText(req.query.q);
        if (!text) {
            res.status(400).json({ message: "q is required" });
            return;
        }
        const items = (
            await onlineItems(req.principal?.location_ids ?? [])
        ).filter((item) => matchesText(item, text));
        sendPage(res, pageOf(items, paging));
    }),
);

itemRouter.get(
    "/online/by-id/:itemId",
    requireScope("catalog:read"),
    online(async (req, res) => {
        const itemId = getParamValue(req.params.itemId);
        const item = (
            await onlineItems(req.principal?.location_ids ?? [])
        ).find((candidate) => candidate.id === itemId);
        if (!item) {
            res.status(404).json({ message: "Item not found" });
            return;
        }
        res.json(item);
    }),
);

itemRouter.get(
    "/online/at/:locationId",
    requireScope("catalog:read"),
    requireLocation((req) => req.params.locationId as string),
    online(async (req, res) => {
        const paging = readPaging(req.query);
        const categoryId = queryText(req.query.category_id);
        const items = (
            await onlineItems(
                req.principal?.location_ids ?? [],
                getParamValue(req.params.locationId),
            )
        ).filter((item) => !categoryId || inCategory(item, categoryId));
        sendPage(res, pageOf(items, paging));
    }),
);

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

        // A pinned principal may only read its own locations' catalogs.
        const allowed = req.principal?.location_ids;
        if (allowed && allowed !== "all" && !allowed.includes(locationId)) {
            res.status(403).json({ message: "Forbidden" });
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
            "No locationID provided, fetching items for the principal's locations.",
        );
        const fetched = await cachedItemsFor(req.principal?.location_ids ?? []);
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
