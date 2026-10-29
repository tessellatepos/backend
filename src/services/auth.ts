import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzleDB } from "./db/postgres";
import { username } from "better-auth/plugins";
import { urlConfig, trustedOrigins } from "@/config/urls";

export const auth = betterAuth({
    baseURL: urlConfig.authBaseUrl,
    trustedOrigins: (request) => trustedOrigins(request),
    database: drizzleAdapter(drizzleDB, {
        provider: "pg",
    }),
    emailAndPassword: {
        enabled: true,
    },
    plugins: [username()],
});
