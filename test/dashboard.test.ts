import "@/test/localProvider";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@/services/db/postgres";
import { createAuth } from "@/services/auth";
import { registerPrincipalResolver } from "@/auth/principal";
import { dashboardv1Endpoint } from "@/endpoints/v1/dashboard";
import { TessellatePluginRegistry } from "@/utils/registry/plugin/pluginRegistry";
import { migrateTestDb } from "./helpers/db";
import { startTestApp, type TestApp } from "./helpers/app";

const suffix = randomUUID().slice(0, 8);
const L1 = `dashA-${suffix}`;
const L2 = `dashB-${suffix}`;
const PINNED = `pinned-${suffix}`;

const money = (amount: number) => ({ amount: String(amount), currency: "CAD" });

interface Seed {
    location: string;
    state: string;
    total: number;
    tender?: string;
    source?: string;
    createdAt?: string;
}

// L1 completed: 1000 cash + 500 card + 300 cash (a split pays both)
// L2 completed: 200 card
const SEEDS: Seed[] = [
    { location: L1, state: "COMPLETED", total: 1000, tender: "CASH" },
    { location: L1, state: "COMPLETED", total: 500, tender: "CARD" },
    { location: L1, state: "COMPLETED", total: 300, tender: "CASH" },
    // outside the window, not completed: must not count as sales
    {
        location: L1,
        state: "COMPLETED",
        total: 9999,
        tender: "CASH",
        createdAt: "2020-01-01T00:00:00Z",
    },
    { location: L1, state: "OPEN", total: 700 },
    { location: L1, state: "CANCELED", total: 800 },
    { location: L2, state: "COMPLETED", total: 200, tender: "CARD" },
    { location: L2, state: "OPEN", total: 50, source: "web-store" },
];

describe("dashboard summary", () => {
    let server: TestApp;
    let ownerCookie: string;
    let viewerCookie: string;
    let cashierCookie: string;
    let unregister: () => void;

    const get = async (path: string, cookie?: string, token?: string) => {
        const res = await fetch(`${server.url}/api/v1/dashboard${path}`, {
            headers: {
                ...(cookie ? { cookie } : {}),
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    async function signIn(role: string) {
        const auth = createAuth();
        const email = `${role}-${suffix}@example.test`;
        await auth.api.createUser({
            body: {
                email,
                password: "correct-horse-battery",
                name: role,
                role: role as "admin",
            },
        });
        const { headers } = await auth.api.signInEmail({
            body: { email, password: "correct-horse-battery" },
            returnHeaders: true,
        });
        return (headers.get("set-cookie") ?? "").split(";")[0];
    }

    before(async () => {
        await migrateTestDb();
        ownerCookie = await signIn("owner");
        viewerCookie = await signIn("viewer");
        cashierCookie = await signIn("cashier");

        for (const [i, s] of SEEDS.entries()) {
            await pool.query(
                `INSERT INTO "tessellate-orders"
                 (reference_id, location_id, source_name, discounts, state,
                  total_money, tenders, created_at)
                 VALUES ($1, $2, $3, '[]', $4, $5, $6, COALESCE($7::timestamptz, now()))`,
                [
                    `ref-${suffix}-${i}`,
                    s.location,
                    s.source ?? null,
                    s.state,
                    JSON.stringify(money(s.total)),
                    JSON.stringify(
                        s.tender
                            ? [{ type: s.tender, amountMoney: money(s.total) }]
                            : [],
                    ),
                    s.createdAt ?? null,
                ],
            );
        }

        // Principals other than users are location-pinned; a service
        // principal is the simplest way to get one over HTTP.
        unregister = registerPrincipalResolver("service", async (req) =>
            req.headers.authorization === `Bearer ${PINNED}`
                ? {
                      kind: "service",
                      id: "pinned",
                      roles: [],
                      scopes: ["dashboard:read"],
                      location_ids: [L2],
                  }
                : null,
        );

        server = await startTestApp((app) => {
            app.locals.pluginRegistry = new TessellatePluginRegistry();
            app.use("/api/v1/dashboard", dashboardv1Endpoint.router);
        });
    });

    after(async () => {
        unregister();
        await server.close();
        await pool.query(
            `DELETE FROM "tessellate-orders" WHERE reference_id LIKE $1`,
            [`ref-${suffix}-%`],
        );
        await pool.query(
            `DELETE FROM "tessellate-auth-user" WHERE email LIKE $1`,
            [`%-${suffix}@example.test`],
        );
        await pool.end();
    });

    it("requires a session and the dashboard:read scope", async () => {
        assert.equal((await get("/summary")).status, 401);
        assert.equal((await get("/summary", cashierCookie)).status, 403);
        assert.equal((await get("/summary", viewerCookie)).status, 200);
        assert.equal((await get("/summary", ownerCookie)).status, 200);
    });

    it("matches a hand calculation for one location", async () => {
        const { body } = await get(`/summary?locationId=${L1}`, ownerCookie);
        assert.equal(body.totals.salesTotal.amount, "1800");
        assert.equal(body.totals.orderCount, 3);
        assert.equal(body.totals.averageOrder.amount, "600");
        assert.equal(body.locations.length, 1);
        assert.equal(body.locations[0].locationId, L1);
        assert.equal(body.openOrders, 1);
        assert.deepEqual(
            body.paymentMethods.map(
                (p: {
                    type: string;
                    count: number;
                    total: { amount: string };
                }) => [p.type, p.count, p.total.amount],
            ),
            [
                ["CASH", 2, "1300"],
                ["CARD", 1, "500"],
            ],
        );
    });

    it("splits the totals per location when none is chosen", async () => {
        const { body } = await get("/summary", ownerCookie);
        const byLoc = Object.fromEntries(
            body.locations.map(
                (l: { locationId: string; salesTotal: { amount: string } }) => [
                    l.locationId,
                    l.salesTotal.amount,
                ],
            ),
        );
        assert.equal(byLoc[L1], "1800");
        assert.equal(byLoc[L2], "200");
    });

    it("honours from and to", async () => {
        const wide = await get(
            `/summary?locationId=${L1}&from=2019-01-01T00:00:00Z`,
            ownerCookie,
        );
        assert.equal(wide.body.totals.salesTotal.amount, "11799");
        assert.equal(wide.body.totals.orderCount, 4);
        const none = await get(
            `/summary?locationId=${L1}&from=2021-01-01T00:00:00Z&to=2021-02-01T00:00:00Z`,
            ownerCookie,
        );
        assert.equal(none.body.totals.orderCount, 0);
        assert.equal(none.body.totals.averageOrder.amount, "0");
        assert.equal(
            (await get("/summary?from=nope", ownerCookie)).status,
            400,
        );
    });

    it("lists recent orders with their source and excludes nothing but drafts", async () => {
        const { body } = await get(`/summary?locationId=${L2}`, ownerCookie);
        assert.equal(body.recentOrders.length, 2);
        const web = body.recentOrders.find(
            (o: { source: string | null }) => o.source === "web-store",
        );
        assert.equal(web.state, "OPEN");
        assert.equal(web.totalMoney.amount, "50");
        assert.equal(body.openOrders, 1);
    });

    it("reports health", async () => {
        const { body } = await get("/summary", ownerCookie);
        assert.deepEqual(body.health.provider, {
            id: "local",
            connected: true,
        });
        assert.equal(body.health.pluginsLoaded, 0);
        assert.equal(typeof body.health.devicesPaired, "number");
    });

    it("limits a pinned principal to its own locations", async () => {
        const all = await get("/summary", undefined, PINNED);
        assert.equal(all.status, 200);
        assert.deepEqual(
            all.body.locations.map((l: { locationId: string }) => l.locationId),
            [L2],
        );
        assert.equal(all.body.totals.salesTotal.amount, "200");
        assert.equal(
            all.body.recentOrders.every(
                (o: { locationId: string }) => o.locationId === L2,
            ),
            true,
        );
        const other = await get(`/summary?locationId=${L1}`, undefined, PINNED);
        assert.equal(other.status, 403);
    });
});
