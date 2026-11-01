import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    initSetupToken,
    isSetupTokenRequired,
    setupTokenMatches,
    clearSetupToken,
} from "@/services/setupToken";

const saved = process.env.SETUP_TOKEN;

afterEach(() => {
    clearSetupToken();
    if (saved === undefined) delete process.env.SETUP_TOKEN;
    else process.env.SETUP_TOKEN = saved;
});

describe("setup token configuration", () => {
    it("requires no token when SETUP_TOKEN is unset", () => {
        delete process.env.SETUP_TOKEN;
        assert.equal(initSetupToken(true), false);
        assert.equal(isSetupTokenRequired(), false);
        assert.equal(setupTokenMatches(""), false);
        assert.equal(setupTokenMatches(undefined), false);
    });

    it("treats a blank SETUP_TOKEN as unset", () => {
        process.env.SETUP_TOKEN = "   ";
        assert.equal(initSetupToken(true), false);
        assert.equal(isSetupTokenRequired(), false);
    });

    it("requires exactly the SETUP_TOKEN value (trimmed) when set", () => {
        process.env.SETUP_TOKEN = "  opt-in-token  ";
        assert.equal(initSetupToken(true), true);
        assert.equal(isSetupTokenRequired(), true);
        assert.equal(setupTokenMatches("opt-in-token"), true);
        assert.equal(setupTokenMatches("opt-in-token-2"), false);
        assert.equal(setupTokenMatches(""), false);
        assert.equal(setupTokenMatches(undefined), false);
    });

    it("does not require a token once an owner exists", () => {
        process.env.SETUP_TOKEN = "opt-in-token";
        assert.equal(initSetupToken(false), false);
        assert.equal(isSetupTokenRequired(), false);
    });

    it("forgets the token when cleared", () => {
        process.env.SETUP_TOKEN = "opt-in-token";
        initSetupToken(true);
        clearSetupToken();
        assert.equal(isSetupTokenRequired(), false);
        assert.equal(setupTokenMatches("opt-in-token"), false);
    });
});
