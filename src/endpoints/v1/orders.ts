import express, { Router } from "express";
import { Logger } from "tslog";
import { createSquareOrder } from "@/services/square";
import { squareOrder } from "@tessellatepos/common/src/types/squareTypes";

export const orderRouter: Router = express.Router();

const logger = new Logger();

orderRouter.post("/create", async (req, res) => {
    try {
        const orderDetails: squareOrder = req.body;

        logger.debug("orderDetails created", orderDetails);

        if (!orderDetails) {
            res.status(400).json({ message: "Missing order details" });
            return;
        }

        const order = await createSquareOrder(orderDetails);

        if (order !== null && order !== undefined) {
            logger.debug("Created order:", order.referenceId);
            res.status(200).json(order);
        } else {
            logger.debug(
                "Failed to create order",
                JSON.stringify(order, (_, v) =>
                    typeof v === "bigint" ? v.toString() : v,
                ),
            );
            res.status(500).json({ message: "Failed to create order" });
        }
    } catch (error) {
        logger.error(error);
        res.status(500).json({ message: "Failed to create order", error });
    }
});
