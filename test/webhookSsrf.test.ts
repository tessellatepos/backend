import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertPublicTarget, isBlockedAddress } from "@/gateway/webhooks/ssrf";
import {
    CredentialValidationError,
    validateWebhookUrl,
} from "@/services/credentials";

const to = (address: string) => async () => [{ address }];

describe("webhook SSRF guard", () => {
    it("blocks private, link-local, unique-local, metadata and loopback addresses", () => {
        for (const ip of [
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "127.0.0.1",
            "0.0.0.0",
            "100.64.0.1",
            "::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
        ]) {
            assert.equal(isBlockedAddress(ip), true, ip);
        }
        for (const ip of [
            "93.184.216.34",
            "172.32.0.1",
            "2606:2800:220:1::1",
        ]) {
            assert.equal(isBlockedAddress(ip), false, ip);
        }
    });

    it("refuses a name that resolves to any private address", async () => {
        await assert.rejects(
            assertPublicTarget("https://a.example.test/", to("192.168.0.9")),
        );
        await assert.rejects(
            assertPublicTarget("https://a.example.test/", async () => [
                { address: "93.184.216.34" },
                { address: "10.0.0.1" },
            ]),
        );
        await assert.rejects(
            assertPublicTarget("https://[fc00::1]/", to("93.184.216.34")),
        );
        await assert.rejects(
            assertPublicTarget("https://169.254.169.254/", to("93.184.216.34")),
        );
        // https to loopback is refused; only http loopback is the dev exception.
        await assert.rejects(
            assertPublicTarget("https://localhost/", to("127.0.0.1")),
        );
    });

    it("allows a public address and http to loopback without resolving", async () => {
        await assertPublicTarget(
            "https://a.example.test/",
            to("93.184.216.34"),
        );
        const boom = async () => {
            throw new Error("should not resolve");
        };
        await assertPublicTarget("http://localhost:8080/hook", boom);
        await assertPublicTarget("http://127.0.0.1:8080/hook", boom);
        await assertPublicTarget("http://[::1]:8080/hook", boom);
    });

    it("rejects private IP literals and plain http at save time", () => {
        for (const url of [
            "http://example.test/",
            "https://10.0.0.1/",
            "https://169.254.169.254/latest",
            "https://[fd00::1]/",
            "https://u:p@example.test/",
        ]) {
            assert.throws(
                () => validateWebhookUrl(url),
                CredentialValidationError,
                url,
            );
        }
        assert.ok(validateWebhookUrl("https://example.test/hook"));
        assert.ok(validateWebhookUrl("http://localhost:3000/hook"));
        assert.ok(validateWebhookUrl("http://127.0.0.1:3000/hook"));
    });
});
