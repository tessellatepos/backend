import express, { Router } from "express";
import { Logger } from "tslog";
import { createSquareOrder } from "@/services/square";

export const orderRouter: Router = express.Router();

const logger = new Logger();

orderRouter.post("/create", async (req, res) => {
    const { orderDetails } = req.body;

    if (!orderDetails) {
        res.status(400).json({ message: "Missing order details" });
        return;
    }

    const order = await createSquareOrder(orderDetails);

    if (order !== null && order !== undefined) {
        logger.debug("Created order:", order.id);
        res.status(200).json(order);
    } else {
        logger.debug("Failed to create order", JSON.stringify(order));
        res.status(500).json({ message: "Failed to create order" });
    }
});
