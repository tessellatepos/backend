import express, { Request, Response, Router } from "express";
import { Logger } from "tslog";
import { requireScope } from "@/middleware/authenticate";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import { getDashboardHealth, getDashboardSummary } from "@/services/dashboard";
import { getActiveProviderId } from "@/services/providers";
import { isAuthorized } from "@/services/squareOauth";
import type { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";

const dashboardRouter: Router = express.Router();

const logger = new Logger();

export const dashboardv1Endpoint: ITessellateApiRouter = {
    route_path: "/dashboard",
    version: "v1",
    router: dashboardRouter,
};

function startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

function parseDate(value: unknown, fallback: Date): Date | null {
    if (value === undefined || value === "") return fallback;
    if (typeof value !== "string") return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

// `from` defaults to the start of today (server time) and `to` to now.
// A location-pinned principal sees only its own locations.
dashboardRouter.get(
    "/summary",
    requireScope("dashboard:read"),
    async (req: Request, res: Response) => {
        const from = parseDate(req.query.from, startOfToday());
        const to = parseDate(req.query.to, new Date());
        if (!from || !to || from > to) {
            res.status(400).json({ message: "Invalid from/to" });
            return;
        }
        const requested = req.query.locationId;
        if (requested !== undefined && typeof requested !== "string") {
            res.status(400).json({ message: "Invalid locationId" });
            return;
        }
        const allowed = req.principal?.location_ids ?? [];
        let locationIds: string[] | null;
        if (requested) {
            if (allowed !== "all" && !allowed.includes(requested)) {
                res.status(403).json({ message: "Forbidden" });
                return;
            }
            locationIds = [requested];
        } else {
            locationIds = allowed === "all" ? null : allowed;
        }

        try {
            const registry = (
                req.app.locals as { pluginRegistry?: TessellatePluginRegistry }
            ).pluginRegistry;
            const providerId = getActiveProviderId();
            const [summary, health] = await Promise.all([
                getDashboardSummary({ from, to, locationIds }),
                getDashboardHealth(
                    {
                        id: providerId,
                        connected:
                            providerId === "local" || (await isAuthorized()),
                    },
                    registry?.getPlugins().size ?? 0,
                ),
            ]);
            res.json({ ...summary, health });
        } catch (err) {
            logger.error("Failed to build dashboard summary:", err);
            res.status(500).json({ message: "Failed to build summary" });
        }
    },
);
