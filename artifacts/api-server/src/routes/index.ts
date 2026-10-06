import { Router, type IRouter } from "express";
import healthRouter from "./health";
import cityPulseReportsRouter from "./citypulse-reports";
import cityPulseIntelligenceRouter from "./citypulse-intelligence";

const router: IRouter = Router();

router.use(healthRouter);
router.use(cityPulseReportsRouter);
router.use(cityPulseIntelligenceRouter);

export default router;
