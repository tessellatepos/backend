import express from "express";
import { Request, Response, Router } from "express";
import { Logger } from "tslog";
import { getConfigSystem } from "@/services/db/configSystem";
import { createConfigDevice, getConfigDeviceByPairingCode, generateParingCode, updateConfigDevice, deleteConfigDevice, getConfigDeviceByID } from "@/services/db/configDevice";
import { IConfigDevice } from "@tessellate-pos/common/src/types/database";

export const itemRouter: Router = express.Router();

const logger = new Logger();

itemRouter.get("/:deviceID", async (req: Request, res: Response) => {
	logger.info(`Received GET request for device ID: ${req.params.deviceID}`);
	const config = await getConfigDeviceByID(req.params.deviceID[0]);
	res.json(config);
});

itemRouter.post("/:deviceID", async (req: Request, res: Response) => {
	logger.info(`Received POST request for device ID: ${req.params.deviceID} with body: ${JSON.stringify(req.body)}`);
	const updatedConfig = req.body as IConfigDevice;
	updateConfigDevice(updatedConfig.id, updatedConfig);
	res.json(updatedConfig);
});

itemRouter.delete("/:deviceID", async (req: Request, res: Response) => {
	logger.info(`Received DELETE request for device ID: ${req.params.deviceID}`);
	const config = await getConfigDeviceByID(req.params.deviceID[0]);
	if (!config) {
		res.status(404).json({ message: "Device configuration does not exist." });
		return;
	} else {
		deleteConfigDevice(req.params.deviceID[0]);
		res.status(200).json({ message: "Device configuration deleted successfully" });
	}
});

itemRouter.get("/pair-device", async (req: Request, res: Response) => {
	logger.info(`Received GET request for pairing device with query: ${JSON.stringify(req.query)}`);
	const config = await createConfigDevice();
	res.json(config);
});

itemRouter.get("/pair-device/:deviceID", async (req: Request, res: Response) => {
	logger.info(`Received GET request for pairing device with paring code: ${req.params.paringCode}`);
	const config = await getConfigDeviceByPairingCode(req.params.paringCod[0]);

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
		}
		await updateConfigDevice(config.id, newConfig);
		res.json(newConfig);
	}
});

itemRouter.put("/pair-device/:paringCode", async (req: Request, res: Response) => {
	logger.info(`Received PUT request for pairing device with ID: ${req.params.deviceID} and body: ${JSON.stringify(req.body)}`);
	const dbConfig = await getConfigDeviceByPairingCode(req.params.paringCode[0]);

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
		}
		await updateConfigDevice(dbConfig.id, newConfig);
		res.json(newConfig);
	} else {
		res.status(400).json({ message: "Invalid pairing code or device already paired" });
	}
});
