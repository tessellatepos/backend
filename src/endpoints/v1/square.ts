import express, { Router } from "express";
import { SquareClient } from "square";
import { Logger } from "tslog";
import {
    createAuthorizationState,
    getAuthorizationStatus,
    getAuthorizationUrl,
    getDecryptedAccessToken,
    getShortLivedAccessToken,
    getSquareEnvironment,
    handleCallback,
    revokeTokens,
} from "@/services/squareOauth";
import { getConfigDeviceByID } from "@/services/db/configDevice";
import { updateCatalogInCache } from "@/services/catalogSync";

export const squareRouter: Router = express.Router();

const logger = new Logger();

squareRouter.get("/locations", async (req, res) => {
    logger.info("Received GET request for Square locations");
    try {
        const token = await getDecryptedAccessToken();
        if (!token) {
            res.status(409).json({ message: "Square is not connected" });
            return;
        }

        const client = new SquareClient({
            token,
            environment: getSquareEnvironment(),
        });
        const response = await client.locations.list();

        res.status(200).json(
            (response.locations ?? []).map((location) => ({
                id: location.id,
                name: location.name ?? location.id,
                status: location.status ?? null,
            })),
        );
    } catch (error) {
        logger.error(error);
        res.status(500).json({ message: "Failed to fetch Square locations" });
    }
});

squareRouter.get("/oauth/authorize", (req, res) => {
    try {
        const state = createAuthorizationState();
        const url = getAuthorizationUrl(state);

        // The frontend asks for the URL and redirects itself; a browser hitting
        // this endpoint directly gets sent to Square.
        if (req.query.redirect === "true") {
            res.redirect(url);
            return;
        }

        res.status(200).json({ url });
    } catch (error) {
        logger.error(error);
        res.status(500).json({
            message: "Failed to build Square authorization URL",
        });
    }
});

squareRouter.get("/oauth/callback", async (req, res) => {
    const settingsUrl = `${process.env.FRONTEND_URL ?? ""}/settings`;
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;

    if (req.query.error) {
        logger.error(`Square denied authorization: ${String(req.query.error)}`);
        res.redirect(`${settingsUrl}?square_auth=error`);
        return;
    }

    if (!code || !state) {
        res.redirect(`${settingsUrl}?square_auth=error`);
        return;
    }

    try {
        await handleCallback(code, state);

        // The seller just granted access — pull their catalog immediately
        // instead of waiting for the hourly sync. Runs in the background so
        // the redirect back to the settings page isn't held up.
        void updateCatalogInCache().catch((err) =>
            logger.error("Post-OAuth catalog sync failed:", err),
        );

        res.redirect(`${settingsUrl}?square_auth=success`);
    } catch (error) {
        logger.error(error);
        res.redirect(`${settingsUrl}?square_auth=error`);
    }
});

squareRouter.get("/oauth/status", async (req, res) => {
    try {
        res.status(200).json(await getAuthorizationStatus());
    } catch (error) {
        logger.error(error);
        res.status(500).json({
            message: "Failed to read Square authorization status",
        });
    }
});

squareRouter.post("/oauth/revoke", async (req, res) => {
    try {
        await revokeTokens();
        res.status(200).json({ authorized: false });
    } catch (error) {
        logger.error(error);
        res.status(500).json({
            message: "Failed to revoke Square authorization",
        });
    }
});

/**
 * Mints a 24-hour Square access token for one payment on a paired device.
 * Devices hold no Square credentials of their own — they come here before
 * every payment and deauthorize the SDK once it's done.
 */
squareRouter.post("/oauth/mobile-token", async (req, res) => {
    try {
        const deviceId: unknown = req.body?.deviceId;

        if (typeof deviceId !== "string" || !deviceId) {
            res.status(400).json({ message: "Missing deviceId" });
            return;
        }

        const device = await getConfigDeviceByID(deviceId);
        if (!device?.paired_at) {
            logger.warn(
                `Rejected mobile token request from unpaired device ${deviceId}`,
            );
            res.status(403).json({ message: "Device is not paired" });
            return;
        }

        const token = await getShortLivedAccessToken();

        // A device pinned to a location overrides the deployment default.
        const locationId = device.square_location ?? token.locationId;
        if (!locationId) {
            res.status(409).json({
                message: "No Square location is configured",
            });
            return;
        }

        res.status(200).json({
            accessToken: token.accessToken,
            locationId,
            expiresAt: token.expiresAt,
            environment: token.environment,
        });
    } catch (error) {
        logger.error(error);
        res.status(500).json({
            message: "Failed to issue a Square access token",
        });
    }
});
