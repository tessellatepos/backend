import express, { Router } from "express";
import { Logger } from "tslog";
import { frontendUrl } from "@/config/urls";
import {
    DEFAULT_RETURN_TO,
    createAuthorizationState,
    getAuthorizationStatus,
    getAuthorizationUrl,
    getDecryptedAccessToken,
    getShortLivedAccessToken,
    handleCallback,
    peekReturnTo,
    revokeTokens,
} from "@/services/squareOauth";
import { getConfigDeviceByID } from "@/services/db/configDevice";
import { updateCatalogInCache } from "@/services/catalogSync";
import { squareProvider } from "@/services/providers/square";
import { requireScope } from "@/middleware/authenticate";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";

const squareRouter: Router = express.Router();

const logger = new Logger();

export const squarev1Endpoint: ITessellateApiRouter = {
    route_path: "/square",
    version: "v1",
    router: squareRouter,
};

squareRouter.get(
    "/locations",
    requireScope("settings:admin"),
    async (req, res) => {
        logger.info("Received GET request for Square locations");
        try {
            const token = await getDecryptedAccessToken();
            if (!token) {
                res.status(409).json({ message: "Square is not connected" });
                return;
            }

            res.status(200).json(await squareProvider.fetchLocations());
        } catch (error) {
            logger.error(error);
            res.status(500).json({
                message: "Failed to fetch Square locations",
            });
        }
    },
);

squareRouter.get(
    "/oauth/authorize",
    requireScope("settings:admin"),
    (req, res) => {
        try {
            const state = createAuthorizationState(req.query.returnTo);
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
    },
);

// A top-level browser navigation from Square: it carries the session cookie.
squareRouter.get(
    "/oauth/callback",
    requireScope("settings:admin"),
    async (req, res) => {
        const code = typeof req.query.code === "string" ? req.query.code : null;
        const state =
            typeof req.query.state === "string" ? req.query.state : null;
        // Where the seller started the flow (allow-listed, stored with the state).
        const returnTo = state ? peekReturnTo(state) : DEFAULT_RETURN_TO;
        const settingsUrl = `${frontendUrl ?? ""}${returnTo}`;

        if (req.query.error) {
            logger.error(
                `Square denied authorization: ${String(req.query.error)}`,
            );
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
    },
);

squareRouter.get(
    "/oauth/status",
    requireScope("settings:read"),
    async (req, res) => {
        try {
            res.status(200).json(await getAuthorizationStatus());
        } catch (error) {
            logger.error(error);
            res.status(500).json({
                message: "Failed to read Square authorization status",
            });
        }
    },
);

squareRouter.post(
    "/oauth/revoke",
    requireScope("settings:admin"),
    async (req, res) => {
        try {
            await revokeTokens();
            res.status(200).json({ authorized: false });
        } catch (error) {
            logger.error(error);
            res.status(500).json({
                message: "Failed to revoke Square authorization",
            });
        }
    },
);

/**
 * Mints a 24-hour Square access token for one payment on a paired device.
 * Devices hold no Square credentials of their own — they come here before
 * every payment and deauthorize the SDK once it's done.
 */
squareRouter.post(
    "/oauth/mobile-token",
    requireScope("orders:write"),
    async (req, res) => {
        try {
            const deviceId: unknown = req.body?.deviceId;

            if (typeof deviceId !== "string" || !deviceId) {
                res.status(400).json({ message: "Missing deviceId" });
                return;
            }

            // A device may only mint a token for itself.
            const principal = req.principal;
            if (principal?.kind === "device" && principal.id !== deviceId) {
                res.status(403).json({ message: "Forbidden" });
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
            // A LOCAL till has no reader; it must not get a Square token.
            if (device.device_type === "LOCAL") {
                res.status(400).json({
                    message: "Local tills have no mobile reader",
                });
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
    },
);
