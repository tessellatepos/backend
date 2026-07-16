import express, { Router } from "express";
import { Logger } from "tslog";
import { createDebugSquareOrder } from "@/services/square";
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

orderRouter.post(":orderId/checkout", async (req, res) => {
    try {
        // const orderId = req.params.orderId;
        // const checkoutDetails: CheckoutDetails
    } catch (error) {
        logger.error(error);
        res.status(500).json({ message: "Failed to checkout order", error });
    }
});
