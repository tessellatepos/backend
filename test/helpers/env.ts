// Throwaway values so the suite runs without the caller exporting secrets.
// Real values from the environment win. Never use these outside tests.
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, "t").toString("base64");
process.env.BETTER_AUTH_SECRET ??= "test-only-better-auth-secret-0123456789";
