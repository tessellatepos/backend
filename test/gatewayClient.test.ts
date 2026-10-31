import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    GatewayError,
    WebhookVerificationError,
    createGatewayClient,
    verifyWebhook,
} from "@tessellatepos/plugin-sdk/gateway";
import { signWebhook } from "@/gateway/webhooks/sign";

const body = JSON.stringify({
    id: "evt_1",
    type: "order.paid",
    created_at: "2026-10-31T00:00:00.000Z",
    data: { id: "o1" },
});
const now = 1_800_000_000_000;
const ts = Math.floor(now / 1000);

describe("plugin-sdk gateway: verifyWebhook", () => {
    it("accepts what the host signs and returns the event", () => {
        const header = signWebhook("whsec_a", ts, body);
        const event = verifyWebhook(body, header, "whsec_a", { now });
        assert.equal(event.type, "order.paid");
    });

    it("rejects a tampered body, a wrong secret and a bad header", () => {
        const header = signWebhook("whsec_a", ts, body);
        for (const [raw, h, secret] of [
            [`${body} `, header, "whsec_a"],
            [body, header, "whsec_b"],
            [body, "garbage", "whsec_a"],
            [body, "", "whsec_a"],
        ] as const) {
            assert.throws(
                () => verifyWebhook(raw, h, secret, { now }),
                WebhookVerificationError,
            );
        }
    });

    it("rejects an old timestamp (replay)", () => {
        const header = signWebhook("whsec_a", ts - 3600, body);
        assert.throws(
            () => verifyWebhook(body, header, "whsec_a", { now }),
            /tolerance/,
        );
    });
});

describe("plugin-sdk gateway: client", () => {
    it("sends Basic auth, fills path params and throws GatewayError", async () => {
        const seen: { url: string; auth: string | null }[] = [];
        const fakeFetch = (async (url: URL, init: RequestInit) => {
            seen.push({
                url: String(url),
                auth: new Headers(init.headers).get("authorization"),
            });
            return url.pathname.endsWith("/bad")
                ? new Response('{"message":"no","code":"missing_scope"}', {
                      status: 403,
                  })
                : new Response('{"ok":true}', { status: 200 });
        }) as unknown as typeof fetch;
        const client = createGatewayClient({
            baseUrl: "https://shop.test/",
            clientId: "id",
            clientSecret: "sec",
            fetch: fakeFetch,
        });
        const out = await client.request("get", "/items/{locationId}", {
            params: { locationId: "a b" },
            query: { limit: 5 },
        });
        assert.deepEqual(out, { ok: true });
        assert.equal(
            seen[0].url,
            "https://shop.test/gateway/v1/items/a%20b?limit=5",
        );
        assert.equal(seen[0].auth, `Basic ${btoa("id:sec")}`);
        await assert.rejects(
            client.request("get", "/bad"),
            (e) => e instanceof GatewayError && e.code === "missing_scope",
        );
    });
});
