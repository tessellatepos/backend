import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzleDB } from "./db/postgres";
import { username } from "better-auth/plugins";

export const auth = betterAuth({
    database: drizzleAdapter(drizzleDB, {
        provider: "pg",
    }),
    emailAndPassword: {
        enabled: true,
    },
    plugins: [username()],
});
