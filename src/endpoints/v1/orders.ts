import express, { Router } from "express";
import { Logger } from "tslog";
import {
    createDebugSquareOrder,
    createTerminalCheckout,
    fetchSquareOrder,
    getTerminalCheckoutStatus,
} from "@/services/square";
import { getPairedDeviceByType } from "@/services/db/configDevice";
import { bigintReplacer } from "@tessellatepos/sdk";
import type { Order } from "@tessellatepos/sdk";

export const orderRouter: Router = express.Router();

const logger = new Logger();

orderRouter.post("/create", async (req, res) => {
    try {
        const orderDetails: Order = req.body;

        logger.debug("orderDetails created", orderDetails);

        if (!orderDetails) {
            res.status(400).json({ message: "Missing order details" });
            return;
        }

        const order = await createDebugSquareOrder(orderDetails);

        if (order !== null && order !== undefined) {
            logger.debug("Created order:", order.referenceId);
            res.status(200)
                .header("Content-Type", "application/json")
                .send(JSON.stringify(order, bigintReplacer));
        } else {
            logger.debug(
                "Failed to create order",
                JSON.stringify(order, bigintReplacer),
            );
            res.status(500).json({ message: "Failed to create order" });
        }
    } catch (error) {
        logger.error(error);
        res.status(500).json({ message: "Failed to create order", error });
    }
});

orderRouter.post("/:orderId/checkout", async (req, res) => {
    try {
        const orderId = req.params.orderId;

        const terminalDevice = await getPairedDeviceByType("TERMINAL");
        const deviceId = terminalDevice?.device_hardware_id;
        if (!deviceId) {
            logger.error("No paired Terminal device is configured");
            res.status(500).json({
                message: "Terminal device is not configured",
            });
            return;
        }

        const order = await fetchSquareOrder(orderId);
        if (!order || !order.totalMoney) {
            res.status(404).json({
                message: "Order not found or missing total",
            });
            return;
        }

        const checkoutId = await createTerminalCheckout(
            orderId,
            order.totalMoney,
            deviceId,
        );

        if (!checkoutId) {
            res.status(500).json({
                message: "Failed to create terminal checkout",
            });
            return;
        }

        const status = await getTerminalCheckoutStatus(checkoutId);

        res.status(200).json({ checkoutId, status });
    } catch (error) {
        logger.error(error);
        res.status(500).json({ message: "Failed to checkout order", error });
    }
});
