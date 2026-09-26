import express from "express";
import { Request, Response, Router } from "express";
import { Logger } from "tslog";
import {
    createConfigDevice,
    getConfigDeviceByPairingCode,
    generatePairingCode,
    updateConfigDevice,
    deleteConfigDevice,
    getConfigDeviceByID,
    getAllConfigDevices,
} from "@/services/db/configDevice";
import { type IConfigDevice } from "@tessellatepos/sdk";
import { getParamValue } from "@/utils/expressHelpers";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";
import { activeProvider } from "@/services/providers";

const configDeviceRouter: Router = express.Router();

const logger = new Logger();

export const configDevicev1Endpoint: ITessellateApiRouter = {
    route_path: "/config/devices",
    version: "v1",
    router: configDeviceRouter,
};

configDeviceRouter.get("/", async (req, res) => {
    logger.info("Received GET request for all device configurations");
    const configSystems = await getAllConfigDevices();
    res.json(configSystems);
});

configDeviceRouter.get("/pair-device/", async (req: Request, res: Response) => {
    logger.info(`Received GET request for a new pairing device`);
    const config = await createConfigDevice();
    res.json(config);
});

configDeviceRouter.get(
    "/pair-device/:pairingCode",
    async (req: Request, res: Response) => {
        const pairingCode = getParamValue(req.params.pairingCode);

        if (!pairingCode || pairingCode === "undefined") {
            res.status(400).json({
                message: "Invalid pairing code format",
            });
            return;
        }

        logger.info(
            `Received GET request for pairing device with paring code: ${pairingCode}`,
        );
        const config = await getConfigDeviceByPairingCode(pairingCode);

        if (config) {
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
    async (req: Request, res: Response) => {
        const deviceId = getParamValue(req.params.deviceId);

        if (!deviceId || deviceId === "undefined") {
            res.status(400).json({
                message: "Invalid deviceID",
            });
            return;
        }

        logger.info(
            `Received DELETE request for pairing device with paring code: ${deviceId}`,
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
    async (req: Request, res: Response) => {
        const pairingCode = getParamValue(req.params.pairingCode);

        if (!pairingCode || pairingCode === "undefined") {
            res.status(400).json({
                message: "Invalid pairing code format",
            });
            return;
        }

        logger.info(
            `Received PUT request for pairing device with ID: ${pairingCode} and body: ${JSON.stringify(req.body)}`,
        );
        const dbConfig = await getConfigDeviceByPairingCode(pairingCode);

        const updatedConfig = req.body as Partial<IConfigDevice>;

        if (!updatedConfig.device_hardware_id) {
            res.status(400).json({
                message: "Missing device_hardware_id in request body",
            });
            return;
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

configDeviceRouter.get("/:deviceId", async (req: Request, res: Response) => {
    const deviceId = getParamValue(req.params.deviceId);

    if (!deviceId || deviceId === "undefined") {
        res.status(400).json({
            message: "Invalid deviceID",
        });
        return;
    }

    logger.info(`Received GET request for device ID: ${deviceId}`);
    const config = await getConfigDeviceByID(deviceId);
    res.json(config);
});

configDeviceRouter.post("/:deviceId", async (req: Request, res: Response) => {
    const deviceId = getParamValue(req.params.deviceId);

    if (!deviceId || deviceId === "undefined") {
        res.status(400).json({
            message: "Invalid deviceID",
        });
        return;
    }

    logger.info(
        `Received POST request for device ID: ${deviceId} with body: ${JSON.stringify(req.body)}`,
    );
    const updatedConfig = req.body as IConfigDevice;
    await updateConfigDevice(deviceId, updatedConfig);
    res.json(updatedConfig);
});

configDeviceRouter.delete("/:deviceId", async (req: Request, res: Response) => {
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
});

// Pairs a physical Square Terminal to this merchant account via Square's own
// Device Code flow — separate from the OTP flow above, which pairs our own
// app onto a phone. The returned code is entered on the terminal's screen.
configDeviceRouter.post(
    "/:deviceId/square-pairing",
    async (req: Request, res: Response) => {
        const deviceId = getParamValue(req.params.deviceId);
        if (!deviceId || deviceId === "undefined") {
            res.status(400).json({ message: "Invalid deviceID" });
            return;
        }

        if (!activeProvider.createDeviceCode) {
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

        const locationId = req.body?.locationId || config.square_location;
        if (!locationId) {
            res.status(400).json({
                message: "A Square location is required to pair a terminal",
            });
            return;
        }

        const name = req.body?.name || `Terminal ${deviceId}`;

        logger.info(`Requesting Square device code for device ID: ${deviceId}`);
        const deviceCode = await activeProvider.createDeviceCode(
            locationId,
            name,
        );

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
    async (req: Request, res: Response) => {
        const deviceId = getParamValue(req.params.deviceId);
        if (!deviceId || deviceId === "undefined") {
            res.status(400).json({ message: "Invalid deviceID" });
            return;
        }

        if (!activeProvider.getDeviceCode) {
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

        const deviceCode = await activeProvider.getDeviceCode(
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
