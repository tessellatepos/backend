import express from "express";
import { Request, Response, Router } from "express";
import { Logger } from "tslog";
import {
    createConfigDevice,
    createLocalDevice,
    getConfigDeviceByPairingCode,
    getLocalDeviceForLocation,
    generatePairingCode,
    updateConfigDevice,
    deleteConfigDevice,
    getConfigDeviceByID,
    getAllConfigDevices,
    withoutTokenHash,
} from "@/services/db/configDevice";
import { getLocationById } from "@/services/db/locations";
import { type IConfigDevice } from "@tessellatepos/sdk";
import { getParamValue } from "@/utils/expressHelpers";
import { hasScope, requireScope } from "@/middleware/authenticate";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import { FixedWindowLimiter, rateLimit } from "@/utils/rateLimiter";
import { deviceTypeEnum } from "@/services/db/schema";
import { getActiveProvider } from "@/services/providers";

const DEVICE_TYPES = deviceTypeEnum.enumValues;
/** Types a hardware pairing may set. A LOCAL till has no hardware to pair. */
const PAIRABLE_TYPES = DEVICE_TYPES.filter((type) => type !== "LOCAL");

const configDeviceRouter: Router = express.Router();

const logger = new Logger();

/** Length of every pairing rate-limit window. */
export const PAIRING_WINDOW_MS = 15 * 60 * 1000;
/** Pairing codes a client IP may request (GET /pair-device/) per window. */
export const PAIR_REQUEST_MAX = 20;
/** Code refreshes a client IP may make (GET /pair-device/:code) per window. */
export const PAIR_REFRESH_MAX = 20;
/** Approvals a client IP may make (PUT /pair-device/:code) per window. */
export const PAIR_APPROVE_MAX = 30;

// Limits are per process (see FixedWindowLimiter) and keyed by req.ip.
const requestLimiter = new FixedWindowLimiter(
    PAIR_REQUEST_MAX,
    PAIRING_WINDOW_MS,
);
const refreshLimiter = new FixedWindowLimiter(
    PAIR_REFRESH_MAX,
    PAIRING_WINDOW_MS,
);
const approveLimiter = new FixedWindowLimiter(
    PAIR_APPROVE_MAX,
    PAIRING_WINDOW_MS,
);

/** Clears the pairing rate limits (tests). */
export function resetPairingLimits(): void {
    requestLimiter.reset();
    refreshLimiter.reset();
    approveLimiter.reset();
}

// Pairing policy
//  - Requesting a code (GET /pair-device/) is public, because a device has no
//    credentials yet, and is rate limited per IP. So is refreshing a code
//    (GET /pair-device/:code), which also needs the current code.
//  - Approving a pairing (PUT /pair-device/:code) needs devices:admin and is
//    rate limited too. Deleting a pairing and every other device mutation
//    need devices:admin.
//  - The token exchange (POST /auth/device-token) needs the device's live
//    pairing code or devices:admin, and failed attempts are rate limited.
// The pairing code is a one-time secret: it is never written to a log line.
export const configDevicev1Endpoint: ITessellateApiRouter = {
    route_path: "/config/devices",
    version: "v1",
    router: configDeviceRouter,
};

configDeviceRouter.get("/", requireScope("devices:read"), async (req, res) => {
    logger.info("Received GET request for all device configurations");
    const configSystems = await getAllConfigDevices();
    res.json(configSystems.map(withoutTokenHash));
});

configDeviceRouter.get(
    "/pair-device/",
    rateLimit(requestLimiter),
    async (req: Request, res: Response) => {
        logger.info(`Received GET request for a new pairing device`);
        const config = await createConfigDevice();
        res.json(config);
    },
);

configDeviceRouter.get(
    "/pair-device/:pairingCode",
    rateLimit(refreshLimiter),
    async (req: Request, res: Response) => {
        const pairingCode = getParamValue(req.params.pairingCode);

        if (!pairingCode || pairingCode === "undefined") {
            res.status(400).json({
                message: "Invalid pairing code format",
            });
            return;
        }

        const config = await getConfigDeviceByPairingCode(pairingCode);

        if (config) {
            logger.info(`Refreshing the pairing code of device ${config.id}`);
            const newConfig = {
                id: config.id,
                created_at: config.created_at,
                pairing_code: generatePairingCode(),
                code_created_at: new Date(),
                paired_at: null,
                square_location: config.square_location,
                customer_facing: config.customer_facing,
                device_hardware_id: config.device_hardware_id,
                device_type: config.device_type,
            };
            await updateConfigDevice(config.id, newConfig);
            res.json(newConfig);
        } else {
            res.status(404).json({ message: "Pairing code not found" });
            return;
        }
    },
);

configDeviceRouter.delete(
    "/pair-device/:deviceId",
    requireScope("devices:admin"),
    async (req: Request, res: Response) => {
        const deviceId = getParamValue(req.params.deviceId);

        if (!deviceId || deviceId === "undefined") {
            res.status(400).json({
                message: "Invalid deviceID",
            });
            return;
        }

        logger.info(
            `Received DELETE request for the pairing of device ${deviceId}`,
        );
        await deleteConfigDevice(deviceId);
        const checkDeleteDevice = await getConfigDeviceByID(deviceId);

        if (!checkDeleteDevice) {
            res.status(200).json({
                message: "Pairing code deleted successfully",
            });
        } else {
            res.status(400).json({
                message: "Failed to delete pairing code",
            });
        }
    },
);

configDeviceRouter.put(
    "/pair-device/:pairingCode",
    requireScope("devices:admin"),
    rateLimit(approveLimiter),
    async (req: Request, res: Response) => {
        const pairingCode = getParamValue(req.params.pairingCode);

        if (!pairingCode || pairingCode === "undefined") {
            res.status(400).json({
                message: "Invalid pairing code format",
            });
            return;
        }

        const updatedConfig = (
            req.body && typeof req.body === "object" ? req.body : {}
        ) as Partial<IConfigDevice>;

        if (
            typeof updatedConfig.device_hardware_id !== "string" ||
            !updatedConfig.device_hardware_id.trim()
        ) {
            res.status(400).json({
                message: "device_hardware_id must be a non-empty string",
            });
            return;
        }
        if (
            updatedConfig.device_type !== undefined &&
            updatedConfig.device_type !== null &&
            !(PAIRABLE_TYPES as readonly unknown[]).includes(
                updatedConfig.device_type,
            )
        ) {
            res.status(400).json({
                message: `device_type must be one of ${PAIRABLE_TYPES.join(", ")}`,
            });
            return;
        }

        const dbConfig = await getConfigDeviceByPairingCode(pairingCode);
        if (dbConfig) {
            logger.info(`Received PUT request to pair device ${dbConfig.id}`);
        }

        if (dbConfig != undefined && !dbConfig.paired_at) {
            const newConfig = {
                id: dbConfig.id,
                created_at: dbConfig.created_at,
                pairing_code: null,
                code_created_at: null,
                paired_at: new Date(),
                square_location: dbConfig.square_location,
                customer_facing: dbConfig.customer_facing,
                device_hardware_id: updatedConfig.device_hardware_id,
                device_type: updatedConfig.device_type ?? dbConfig.device_type,
            };
            await updateConfigDevice(dbConfig.id, newConfig);
            res.json(newConfig);
        } else {
            res.status(400).json({
                message: "Invalid pairing code or device already paired",
            });
        }
    },
);

// Staff running a local till need their till's own record, but not the device
// list (it carries pairing codes), so locations:read alone may read a LOCAL
// device at one of the principal's locations.
configDeviceRouter.get(
    "/:deviceId",
    requireScope("devices:read", "locations:read"),
    async (req: Request, res: Response) => {
        const deviceId = getParamValue(req.params.deviceId);

        if (!deviceId || deviceId === "undefined") {
            res.status(400).json({
                message: "Invalid deviceID",
            });
            return;
        }

        logger.info(`Received GET request for device ID: ${deviceId}`);
        const config = await getConfigDeviceByID(deviceId);

        const principal = req.principal;
        if (principal && !hasScope(principal, "devices:read")) {
            const allowed = principal.location_ids;
            const visible =
                config?.device_type === "LOCAL" &&
                (allowed === "all" ||
                    allowed.includes(config.square_location ?? ""));
            if (!visible) {
                res.status(403).json({ message: "Forbidden" });
                return;
            }
        }

        res.json(config && withoutTokenHash(config));
    },
);

// Creates the cash-only till for a location, or returns the one it already
// has. Any provider's location id works. Declared before "/:deviceId" so the
// word "local" is not taken for a device id.
configDeviceRouter.post(
    "/local",
    requireScope("devices:admin"),
    async (req: Request, res: Response) => {
        const locationId: unknown = req.body?.locationId;
        if (typeof locationId !== "string" || !locationId) {
            res.status(400).json({ message: "locationId is required" });
            return;
        }

        if (!(await getLocationById(locationId))) {
            res.status(404).json({ message: "Location not found" });
            return;
        }

        const existing = await getLocalDeviceForLocation(locationId);
        if (existing) {
            res.status(200).json(withoutTokenHash(existing));
            return;
        }

        const device = await createLocalDevice(locationId);
        logger.info(`Created LOCAL device ${device.id}`);
        res.status(201).json(withoutTokenHash(device));
    },
);

configDeviceRouter.post(
    "/:deviceId",
    requireScope("devices:admin"),
    async (req: Request, res: Response) => {
        const deviceId = getParamValue(req.params.deviceId);

        if (!deviceId || deviceId === "undefined") {
            res.status(400).json({
                message: "Invalid deviceID",
            });
            return;
        }

        // The body can carry a pairing code, so it is not logged.
        logger.info(`Received POST request for device ID: ${deviceId}`);
        // Never let a request body set or clear the device token hash.
        const updatedConfig = withoutTokenHash(req.body as IConfigDevice);
        await updateConfigDevice(deviceId, updatedConfig);
        res.json(updatedConfig);
    },
);

configDeviceRouter.delete(
    "/:deviceId",
    requireScope("devices:admin"),
    async (req: Request, res: Response) => {
        const deviceId = getParamValue(req.params.deviceId);

        if (!deviceId || deviceId === "undefined") {
            res.status(400).json({
                message: "Invalid deviceID",
            });
            return;
        }

        logger.info(`Received DELETE request for device ID: ${deviceId}`);
        const config = await getConfigDeviceByID(deviceId);
        if (!config) {
            res.status(404).json({
                message: "Device configuration does not exist.",
            });
            return;
        } else {
            await deleteConfigDevice(deviceId);
            res.status(200).json({
                message: "Device configuration deleted successfully",
            });
        }
    },
);

// Pairs a physical Square Terminal to this merchant account via Square's own
// Device Code flow — separate from the OTP flow above, which pairs our own
// app onto a phone. The returned code is entered on the terminal's screen.
configDeviceRouter.post(
    "/:deviceId/square-pairing",
    requireScope("devices:admin"),
    async (req: Request, res: Response) => {
        const provider = getActiveProvider();
        const deviceId = getParamValue(req.params.deviceId);
        if (!deviceId || deviceId === "undefined") {
            res.status(400).json({ message: "Invalid deviceID" });
            return;
        }

        if (!provider.createDeviceCode) {
            res.status(400).json({
                message: "Device pairing is not supported by this provider",
            });
            return;
        }

        const config = await getConfigDeviceByID(deviceId);
        if (!config) {
            res.status(404).json({
                message: "Device configuration does not exist.",
            });
            return;
        }

        // A LOCAL till has no card hardware; pairing would turn it into one.
        if (config.device_type === "LOCAL") {
            res.status(400).json({
                message: "Local tills have no terminal to pair",
            });
            return;
        }

        const locationId = req.body?.locationId || config.square_location;
        if (!locationId) {
            res.status(400).json({
                message: "A Square location is required to pair a terminal",
            });
            return;
        }

        const name = req.body?.name || `Terminal ${deviceId}`;

        logger.info(`Requesting Square device code for device ID: ${deviceId}`);
        const deviceCode = await provider.createDeviceCode(locationId, name);

        if (!deviceCode) {
            res.status(500).json({
                message: "Failed to create Square device code",
            });
            return;
        }

        await updateConfigDevice(deviceId, {
            device_type: "TERMINAL",
            square_location: locationId,
            square_device_code_id: deviceCode.id,
            square_pair_by: deviceCode.pairBy
                ? new Date(deviceCode.pairBy)
                : null,
        });

        res.status(200).json({
            code: deviceCode.code,
            pairBy: deviceCode.pairBy,
        });
    },
);

// Polls the status of a pending Square Terminal pairing. Once Square reports
// the code as PAIRED, the terminal's real Square device_id is saved so
// order checkouts can be created against it.
configDeviceRouter.get(
    "/:deviceId/square-pairing",
    requireScope("devices:admin"),
    async (req: Request, res: Response) => {
        const provider = getActiveProvider();
        const deviceId = getParamValue(req.params.deviceId);
        if (!deviceId || deviceId === "undefined") {
            res.status(400).json({ message: "Invalid deviceID" });
            return;
        }

        if (!provider.getDeviceCode) {
            res.status(400).json({
                message: "Device pairing is not supported by this provider",
            });
            return;
        }

        const config = await getConfigDeviceByID(deviceId);
        if (!config?.square_device_code_id) {
            res.status(404).json({
                message: "No pending Square pairing for this device",
            });
            return;
        }

        const deviceCode = await provider.getDeviceCode(
            config.square_device_code_id,
        );
        if (!deviceCode) {
            res.status(404).json({ message: "Square pairing not found" });
            return;
        }

        if (deviceCode.status === "PAIRED" && deviceCode.deviceId) {
            await updateConfigDevice(deviceId, {
                square_device_id: deviceCode.deviceId,
                square_device_code_id: null,
                square_pair_by: null,
                paired_at: new Date(),
            });
        }

        res.status(200).json({ status: deviceCode.status });
    },
);
