import { after, before, describe } from "node:test";
import { closeTestDb, setupTestDb } from "@/test/db";
import { catalogContract } from "./catalog.contract";
import { contractTargets } from "./harness";
import { locationsContract } from "./locations.contract";

describe("provider contracts", () => {
    before(setupTestDb);
    after(closeTestDb);

    for (const target of contractTargets) {
        locationsContract(target);
        catalogContract(target);
    }
});
