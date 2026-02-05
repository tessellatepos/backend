"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeRedisClient = initializeRedisClient;
const redis_1 = require("redis");
const ts_logger_1 = require("@origranot/ts-logger");
const logger = new ts_logger_1.Logger();
let redis = null;
const getRedisClient = () => {
    if (!redis) {
        redis = initializeRedisClient();
    }
    return redis;
};
function initializeRedisClient() {
    if (!process.env.REDIS_URL) {
        logger.error("No REDIS_URL found in environment variables");
        throw new Error("No REDIS_URL found in environment variables");
    }
    if (!process.env.REDIS_PASSWORD) {
        logger.error("No REDIS_PASSWORD found in environment variables");
        throw new Error("No REDIS_PASSWORD found in environment variables");
    }
    redis = (0, redis_1.createClient)({
        url: process.env.REDIS_URL,
        password: process.env.REDIS_PASSWORD,
    });
    return redis;
}
async function connectRedis() {
    await getRedisClient().connect();
    logger.debug("Connected to Redis");
}
getRedisClient().on('error', (err) => {
    logger.error('Redis Client Error: ', err);
});
connectRedis().catch(console.error);
