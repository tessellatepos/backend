import express from "express";
import { Request, Response, Router } from "express";
import { Logger } from "tslog";
import {
    createConfigDevice,
    getConfigDeviceByPairingCode,
    generateParingCode,
    updateConfigDevice,
    deleteConfigDevice,
    getConfigDeviceByID,
    getAllConfigDevices,
} from "@/services/db/configDevice";
import { type IConfigDevice } from "@tessellatepos/sdk";
import { getParamValue } from "@/utils/expressHelpers";
import { ITessellateApiRouter } from "@/utils/registry/api/apiRegistry";

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
                paring_code: generateParingCode(),
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
                paring_code: null,
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
