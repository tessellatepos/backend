import express, { Router } from "express";
import { Logger } from "tslog";
import { activeProvider } from "@/services/providers";
import { getPairedDeviceByType } from "@/services/db/configDevice";
import { insertOrder, syncOrderFromSquare } from "@/services/db/orders";
import { bigintReplacer } from "@tessellatepos/sdk";
import type { Money, Order } from "@tessellatepos/sdk";
import { emitPaymentStatusEvent } from "@/services/websocket/events";

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

        const order = await activeProvider.createOrder(orderDetails);

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

        if (!activeProvider.createTerminalCheckout) {
            res.status(400).json({
                message: "Terminal checkout is not supported by this provider",
            });
            return;
        }

        const terminalDevice = await getPairedDeviceByType("TERMINAL");
        const deviceId = terminalDevice?.device_hardware_id;
        if (!deviceId) {
            logger.error("No paired Terminal device is configured");
            res.status(500).json({
                message: "Terminal device is not configured",
            });
            return;
        }

        const order = await activeProvider.fetchOrder(orderId);
        if (!order || !order.totalMoney) {
            res.status(404).json({
                message: "Order not found or missing total",
            });
            return;
        }

        const checkoutId = await activeProvider.createTerminalCheckout(
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

        const status =
            await activeProvider.getTerminalCheckoutStatus?.(checkoutId);

        res.status(200).json({ checkoutId, status });
    } catch (error) {
        logger.error(error);
        res.status(500).json({ message: "Failed to checkout order", error });
    }
});

orderRouter.get("/:orderId/checkout/:checkoutId", async (req, res) => {
    try {
        const { checkoutId } = req.params;

        const status =
            await activeProvider.getTerminalCheckoutStatus?.(checkoutId);
        if (!status) {
            res.status(404).json({ message: "Checkout not found" });
            return;
        }

        if (status === "COMPLETED") {
            const order = await activeProvider.fetchOrder(req.params.orderId);
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

        const order = await activeProvider.fetchOrder(orderId);
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

        await activeProvider.payCash(orderId, tenderedMoney, order.totalMoney);

        const paidOrder = await activeProvider.fetchOrder(orderId);
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

        if (!activeProvider.confirmMobileReaderPayment) {
            res.status(400).json({
                message:
                    "Mobile reader payment is not supported by this provider",
            });
            return;
        }

        const verified = await activeProvider.confirmMobileReaderPayment(
            orderId,
            paymentId,
        );
        if (!verified) {
            res.status(400).json({
                message: "Mobile reader payment could not be verified",
            });
            return;
        }

        const order = await activeProvider.fetchOrder(orderId);
        if (!order) {
            res.status(404).json({ message: "Order not found" });
            return;
        }
        await syncOrderFromSquare(order);

        emitPaymentStatusEvent({
            type: "payment_status",
            payload: {
                orderId,
                status: "COMPLETED",
                paymentMethod: "MOBILE_READER",
                paymentId,
            },
        });

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
