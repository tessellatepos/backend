"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cache_1 = require("./utils/cache");
const app = (0, express_1.default)();
const redis = (0, cache_1.initializeRedisClient)();
redis.ping();
