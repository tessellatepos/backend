import express, { Router } from "express";
import { Logger } from "tslog";
import {
    confirmMobileReaderPayment,
    createSquareOrder,
    createTerminalCheckout,
    fetchSquareOrder,
    getTerminalCheckoutStatus,
    paySquareOrderWithCash,
} from "@/services/square";
import { getPairedDeviceByType } from "@/services/db/configDevice";
import { insertOrder, syncOrderFromSquare } from "@/services/db/orders";
import { bigintReplacer } from "@tessellatepos/sdk";
import type { Money, Order } from "@tessellatepos/sdk";

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

        orderDetails.referenceId = crypto.randomUUID();

        const order = await createSquareOrder(orderDetails);

        if (order !== null && order !== undefined) {
            logger.debug("Created order:", order.referenceId);
            await insertOrder(order);
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

orderRouter.get("/:orderId/checkout/:checkoutId", async (req, res) => {
    try {
        const { checkoutId } = req.params;

        const status = await getTerminalCheckoutStatus(checkoutId);
        if (!status) {
            res.status(404).json({ message: "Checkout not found" });
            return;
        }

        if (status === "COMPLETED") {
            const order = await fetchSquareOrder(req.params.orderId);
            if (order) {
                await syncOrderFromSquare(order);
            }
        }

        res.status(200).json({ checkoutId, status });
    } catch (error) {
        logger.error(error);
        res.status(500).json({
            message: "Failed to get checkout status",
            error,
        });
    }
});

orderRouter.post("/:orderId/pay-cash", async (req, res) => {
    try {
        const orderId = req.params.orderId;
        const amountTendered = req.body?.amountTendered;

        if (amountTendered === undefined || amountTendered === null) {
            res.status(400).json({ message: "Missing amountTendered" });
            return;
        }

        const order = await fetchSquareOrder(orderId);
        if (!order || !order.totalMoney) {
            res.status(404).json({
                message: "Order not found or missing total",
            });
            return;
        }

        const tenderedMoney: Money = {
            amount: BigInt(amountTendered),
            currency: order.totalMoney.currency,
        };

        if (tenderedMoney.amount! < order.totalMoney.amount!) {
            res.status(400).json({
                message: "Amount tendered is less than the order total",
            });
            return;
        }

        await paySquareOrderWithCash(orderId, tenderedMoney, order.totalMoney);

        const paidOrder = await fetchSquareOrder(orderId);
        if (!paidOrder) {
            res.status(500).json({
                message: "Payment may have succeeded but order refetch failed",
            });
            return;
        }
        await syncOrderFromSquare(paidOrder);

        res.status(200)
            .header("Content-Type", "application/json")
            .send(JSON.stringify(paidOrder, bigintReplacer));
    } catch (error) {
        logger.error(error);
        res.status(500).json({ message: "Failed to pay with cash", error });
    }
});

orderRouter.post("/:orderId/pay-mobile-reader", async (req, res) => {
    try {
        const orderId = req.params.orderId;
        const paymentId = req.body?.paymentId;

        if (!paymentId) {
            res.status(400).json({ message: "Missing paymentId" });
            return;
        }

        const verified = await confirmMobileReaderPayment(orderId, paymentId);
        if (!verified) {
            res.status(400).json({
                message: "Mobile reader payment could not be verified",
            });
            return;
        }

        const order = await fetchSquareOrder(orderId);
        if (!order) {
            res.status(404).json({ message: "Order not found" });
            return;
        }
        await syncOrderFromSquare(order);

        res.status(200)
            .header("Content-Type", "application/json")
            .send(JSON.stringify(order, bigintReplacer));
    } catch (error) {
        logger.error(error);
        res.status(500).json({
            message: "Failed to confirm mobile reader payment",
            error,
        });
    }
});
