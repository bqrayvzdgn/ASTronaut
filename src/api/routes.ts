import { Router } from "express";
import { healthHandler } from "./healthHandler";
import { webhookHandler } from "./webhookHandler";

const router = Router();

router.get("/health", healthHandler);
router.post("/webhook/github", webhookHandler);

export default router;
