/**
 * Redis token bucket for the gateway. Each key holds `capacity` tokens that
 * refill at `perMinute / 60` per second, so a client may burst up to the
 * capacity and then continues at the steady rate. Check and take happen in
 * one Lua script, so concurrent requests cannot both spend the last token.
 */
import { getRedisClient } from "@/services/redis";

const TAKE_TOKEN = `
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = cap
  ts = now
end
tokens = math.min(cap, tokens + (now - ts) * rate)
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate) + 1000)
return { allowed, retry }
`;

/** Outcome of taking a token. */
export interface TokenResult {
    allowed: boolean;
    /** Milliseconds until one token is available again; 0 when allowed. */
    retryAfterMs: number;
}

/**
 * Takes one token from a bucket, creating it full on first use.
 * @param key the bucket key, e.g. "gw:rl:cred:<id>"
 * @param perMinute steady refill rate, tokens per minute
 * @param capacity the burst size
 * @returns whether the call may proceed
 * @throws when Redis is unreachable (callers fail closed)
 */
export async function takeToken(
    key: string,
    perMinute: number,
    capacity: number,
): Promise<TokenResult> {
    const redis = await getRedisClient();
    const [allowed, retry] = (await redis.eval(TAKE_TOKEN, {
        keys: [key],
        arguments: [
            String(capacity),
            String(perMinute / 60_000),
            String(Date.now()),
        ],
    })) as [number, number];
    return { allowed: allowed === 1, retryAfterMs: retry };
}
