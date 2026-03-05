import express, { Router } from "express";

export const baseRouter: Router = express.Router();

baseRouter.get("/", (req, res) => {
    res.json({ message: "Welcome to the Tessellate POS API" });
});

baseRouter.get("/frontend", (req, res) => {
    res.json({ url: process.env.FRONTEND_URL });
});
