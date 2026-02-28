import express from "express";
import { Request, Response, Router } from "express";
import { Logger } from "tslog";
import { getConfigSystem } from "@/services/db/configSystem";
import {
    createConfigDevice,
    getConfigDeviceByPairingCode,
    generateParingCode,
    updateConfigDevice,
    deleteConfigDevice,
    getConfigDeviceByID,
    getAllConfigDevices,
} from "@/services/db/configDevice";
import { IConfigDevice } from "@tessellate-pos/common/src/types/database";

export const configDeviceRouter: Router = express.Router();

const logger = new Logger();

configDeviceRouter.get("/", async (req, res) => {
    logger.info("Received GET request for all device configurations");
    const configSystems = await getAllConfigDevices();
    res.json(configSystems);
});

configDeviceRouter.get("/pair-device/", async (req: Request, res: Response) => {
    logger.info(
        `Received GET request for pairing device with query: ${JSON.stringify(req.query)}`,
    );
    const config = await createConfigDevice();
    res.json(config);
});

configDeviceRouter.get(
    "/pair-device/:deviceID",
    async (req: Request, res: Response) => {
        logger.info(
            `Received GET request for pairing device with paring code: ${req.params.paringCode}`,
        );
        const config = await getConfigDeviceByPairingCode(
            req.params.paringCod[0],
        );

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
            };
            await updateConfigDevice(config.id, newConfig);
            res.json(newConfig);
        }
    },
);

configDeviceRouter.delete(
    "/pair-device/:pairingCode",
    async (req: Request, res: Response) => {
        logger.info(
            `Received DELETE request for pairing device with paring code: ${req.params.pairingCode}`,
        );

        const pairingCode = () => {
            if (typeof req.params.pairingCode === "string") {
                return req.params.pairingCode;
            } else if (Array.isArray(req.params.pairingCode)) {
                return req.params.pairingCode[0];
            } else {
                throw new Error("Invalid pairing code format");
            }
        };

        const deleteDevice = await deleteConfigDevice(pairingCode());

        const checkDeleteDevice =
            await getConfigDeviceByPairingCode(pairingCode());

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
        logger.info(
            `Received PUT request for pairing device with ID: ${req.params.pairingCode[0]} and body: ${JSON.stringify(req.body)}`,
        );
        const dbConfig = await getConfigDeviceByPairingCode(
            req.params.pairingCode[0],
        );

        const updatedConfig = req.body as IConfigDevice;

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

configDeviceRouter.get("/:deviceID", async (req: Request, res: Response) => {
    logger.info(`Received GET request for device ID: ${req.params.deviceID}`);
    const config = await getConfigDeviceByID(req.params.deviceID[0]);
    res.json(config);
});

configDeviceRouter.post("/:deviceID", async (req: Request, res: Response) => {
    logger.info(
        `Received POST request for device ID: ${req.params.deviceID} with body: ${JSON.stringify(req.body)}`,
    );
    const updatedConfig = req.body as IConfigDevice;
    updateConfigDevice(updatedConfig.id, updatedConfig);
    res.json(updatedConfig);
});

configDeviceRouter.delete("/:deviceID", async (req: Request, res: Response) => {
    logger.info(
        `Received DELETE request for device ID: ${req.params.deviceID}`,
    );
    const config = await getConfigDeviceByID(req.params.deviceID[0]);
    if (!config) {
        res.status(404).json({
            message: "Device configuration does not exist.",
        });
        return;
    } else {
        deleteConfigDevice(req.params.deviceID[0]);
        res.status(200).json({
            message: "Device configuration deleted successfully",
        });
    }
});
