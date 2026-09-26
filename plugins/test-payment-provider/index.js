// Dummy plugin used to verify the host's plugin loader — no real payment
// logic, just enough registration to prove activation works end to end,
// including a hook and an event listener.
import { hooks, events } from "@tessellatepos/plugin-sdk/server";
import { PluginColumnType } from "@tessellatepos/plugin-sdk";

export default function register(plugin) {
    // API mount
    plugin.register("api", {
        route: "/payment/test-provider",
        method: "POST",
        handler: async () => ({ status: 200, body: { ok: true } }),
    });

    // Own database: insert a row into this plugin's "transactions" table
    plugin.register("api", {
        route: "/payment/test-provider/transaction",
        method: "POST",
        handler: async (req, ctx) => {
            const { referenceId, amount, metadata } = req.body ?? {};

            const transaction = await ctx.db.table("transactions").insert({
                reference_id: referenceId,
                amount,
                metadata: metadata ?? null,
            });

            return { status: 201, body: { transaction } };
        },
    });

    // Own database: list every row currently in "transactions"
    plugin.register("api", {
        route: "/payment/test-provider/transaction",
        method: "GET",
        handler: async (_req, ctx) => {
            const transactions = await ctx.db.table("transactions").find();
            return { status: 200, body: { transactions } };
        },
    });

    // Host database: look up an order through the host-provided context
    plugin.register("api", {
        route: "/payment/test-provider/order/:orderId",
        method: "GET",
        handler: async (req, ctx) => {
            const order = await ctx.getOrder(req.params.orderId);
            if (!order) {
                return { status: 404, body: { error: "order not found" } };
            }
            return { status: 200, body: { order } };
        },
    });

    // Host catalog cache: look up a catalog item through the host-provided context
    plugin.register("api", {
        route: "/payment/test-provider/item/:itemId",
        method: "GET",
        handler: async (req, ctx) => {
            const item = await ctx.lookupItem(req.params.itemId);
            if (!item) {
                return { status: 404, body: { error: "item not found" } };
            }
            return { status: 200, body: { item } };
        },
    });

    // Hook: runs before order creation, can modify or block
    plugin.hook(hooks.beforeOrderCreate, async (order) => {
        console.log(
            `[test-payment-provider] Intercepting order: ${order.referenceId ?? "(pending)"}`,
        );
        return { ok: true, value: order };
    });

    // Event: runs after order creation, fire and forget
    plugin.on(events.orderCreated, (order) => {
        console.log(
            `[test-payment-provider] Order created: ${order.referenceId}`,
        );
    });

    plugin.register("database", {
        tables: [
            {
                name: "transactions",
                columns: [
                    {
                        name: "id",
                        type: PluginColumnType.INTEGER,
                        primaryKey: true,
                        auto_increment: true,
                    },
                    {
                        name: "reference_id",
                        type: PluginColumnType.VARCHAR,
                        length: 64,
                        unique: true,
                    },
                    {
                        name: "amount",
                        type: PluginColumnType.INTEGER,
                    },
                    {
                        name: "status",
                        type: PluginColumnType.VARCHAR,
                        length: 32,
                        default: "pending",
                    },
                    {
                        name: "metadata",
                        type: PluginColumnType.JSONB,
                        nullable: true,
                    },
                    {
                        name: "created_at",
                        type: PluginColumnType.TIMESTAMP,
                        nullable: true,
                    },
                ],
            },
        ],
    })
}
