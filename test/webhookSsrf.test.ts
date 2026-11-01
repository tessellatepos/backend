import { afterEach, describe, it } from "node:test";
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

    it("blocks IPv4-embedded IPv6 literals in dotted and hex forms", () => {
        for (const ip of [
            "::ffff:127.0.0.1",
            "::ffff:7f00:1",
            "::ffff:a9fe:a9fe", // 169.254.169.254
            "::ffff:0:0",
            "0:0:0:0:0:ffff:7f00:1",
            "::7f00:1",
            "::127.0.0.1",
            "::a9fe:a9fe",
            "::",
            "64:ff9b::7f00:1",
            "64:ff9b::808:808", // NAT64 is refused outright
            "2002:7f00:1::",
            "2002:808:808::", // 6to4 is refused outright
        ]) {
            assert.equal(isBlockedAddress(ip), true, ip);
        }
        for (const ip of ["::ffff:5db8:d822", "::ffff:93.184.216.34"]) {
            assert.equal(isBlockedAddress(ip), false, ip);
        }
    });

    it("refuses URL forms that normalise to a mapped loopback or metadata host", async () => {
        for (const url of [
            "https://[::ffff:127.0.0.1]/",
            "https://[::ffff:169.254.169.254]/",
            "https://[::7f00:1]/",
            "https://[::ffff:a9fe:a9fe]/",
        ]) {
            assert.throws(
                () => validateWebhookUrl(url),
                CredentialValidationError,
                url,
            );
            await assert.rejects(
                assertPublicTarget(url, to("93.184.216.34")),
                url,
            );
        }
    });
});

describe("webhook loopback exception by NODE_ENV", () => {
    const original = process.env.NODE_ENV;
    afterEach(() => {
        if (original === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = original;
    });
    const boom = async () => {
        throw new Error("should not resolve");
    };

    it("accepts http loopback outside production, at save and delivery", async () => {
        process.env.NODE_ENV = "development";
        for (const url of [
            "http://localhost:3000/hook",
            "http://127.0.0.1:3000/hook",
            "http://[::1]:3000/hook",
        ]) {
            assert.ok(validateWebhookUrl(url), url);
            await assertPublicTarget(url, boom);
        }
    });

    it("requires https and a public address in production", async () => {
        process.env.NODE_ENV = "production";
        for (const url of [
            "http://localhost:3000/hook",
            "http://127.0.0.1:3000/hook",
            "http://[::1]:3000/hook",
            "https://127.0.0.1/hook",
            "https://[::1]/hook",
        ]) {
            assert.throws(
                () => validateWebhookUrl(url),
                CredentialValidationError,
                url,
            );
            await assert.rejects(assertPublicTarget(url, to("127.0.0.1")), url);
        }
        assert.ok(validateWebhookUrl("https://example.test/hook"));
        await assertPublicTarget("https://example.test/", to("93.184.216.34"));
    });
});
