import express, { Request, Response, Router } from "express";
import { Logger } from "tslog";
import { getLocationById, getLocations } from "@/services/db/locations";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";

const locationRouter: Router = express.Router();

const logger = new Logger();

export const locationsv1Endpoint: ITessellateApiRouter = {
    route_path: "/locations",
    version: "v1",
    router: locationRouter,
};

// Reads the persisted locations, so it works for any provider, unlike
// Square's own locations list.
locationRouter.get("/", async (_req: Request, res: Response) => {
    try {
        res.json(await getLocations());
    } catch (err) {
        logger.error("Failed to list locations:", err);
        res.status(500).json({ message: "Failed to list locations" });
    }
});

locationRouter.get(
    "/:locationId",
    async (req: Request<{ locationId: string }>, res: Response) => {
        try {
            const location = await getLocationById(req.params.locationId);
            if (!location) {
                res.status(404).json({ message: "Location not found" });
                return;
            }
            res.json(location);
        } catch (err) {
            logger.error("Failed to fetch location:", err);
            res.status(500).json({ message: "Failed to fetch location" });
        }
    },
);
