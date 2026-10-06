import { Router, type IRouter } from "express";
import {
  AskCityAssistantBody,
  AskCityAssistantResponse,
  GetCityAnalyticsQueryParams,
  GetCityAnalyticsResponse,
  GetCityDashboardResponse,
  ListCityAlertsResponse,
  ListCityPredictionsResponse,
  ListCityRiskScoresResponse,
  UpdateCityAlertBody,
  UpdateCityAlertParams,
  UpdateCityAlertResponse,
} from "@workspace/api-zod";
import {
  requireCityPulseAdmin,
  requireCityPulseContext,
} from "../lib/citypulse-auth";
import { withCityPulseErrors } from "../lib/citypulse-errors";
import {
  answerCityPulseQuestion,
  type AssistantStats,
} from "../lib/citypulse-ai";

const router: IRouter = Router();

async function getAccessibleReports(
  client: Awaited<ReturnType<typeof requireCityPulseContext>>["client"],
  userId: string,
  role: "CITIZEN" | "ADMIN",
) {
  let query = client.from("reports").select("*").order("created_at", {
    ascending: false,
  });
  if (role !== "ADMIN") {
    query = query.eq("user_id", userId).eq("is_demo", false);
  }
  const { data, error } = await query.limit(1000);
  if (error) throw error;
  return data ?? [];
}

router.get(
  "/citypulse/dashboard",
  withCityPulseErrors(async (request, response): Promise<void> => {
    const context = await requireCityPulseContext(request);
    const [reports, { data: scores, error: scoreError }, { data: demoRows, error: demoError }] = await Promise.all([
      getAccessibleReports(
        context.client,
        context.user.id,
        context.profile.role,
      ),
      context.client.from("risk_scores").select("*"),
      context.client.from("reports").select("id").eq("is_demo", true).limit(1),
    ]);
    if (scoreError) throw scoreError;
    if (demoError) throw demoError;

    const summary = {
      role: context.profile.role,
      total_reports: reports.length,
      pending: reports.filter((report) => report.status === "PENDING_VERIFICATION").length,
      verified: reports.filter((report) => report.status === "VERIFIED").length,
      resolved: reports.filter((report) => report.status === "RESOLVED").length,
      high_risk_areas: (scores ?? []).filter((score) => score.risk_level === "HIGH").length,
      recent_reports: reports.slice(0, 5),
      demo_mode: (demoRows ?? []).length > 0,
    };
    response.json(GetCityDashboardResponse.parse(summary));
  }),
);

router.get(
  "/citypulse/risk-scores",
  withCityPulseErrors(async (request, response): Promise<void> => {
    const context = await requireCityPulseContext(request);
    const { data, error } = await context.client
      .from("risk_scores")
      .select("*")
      .order("overall_risk", { ascending: false });
    if (error) throw error;
    response.json(ListCityRiskScoresResponse.parse(data ?? []));
  }),
);

router.get(
  "/citypulse/predictions",
  withCityPulseErrors(async (request, response): Promise<void> => {
    const context = await requireCityPulseContext(request);
    const { data, error } = await context.client
      .from("predictions")
      .select("*")
      .order("probability", { ascending: false });
    if (error) throw error;
    response.json(ListCityPredictionsResponse.parse(data ?? []));
  }),
);

router.get(
  "/citypulse/analytics",
  withCityPulseErrors(async (request, response): Promise<void> => {
    const context = await requireCityPulseContext(request);
    requireCityPulseAdmin(context.profile);
    const parsed = GetCityAnalyticsQueryParams.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid analytics range." });
      return;
    }

    const range = parsed.data.range ?? "30D";
    const dayCount = range === "7D" ? 7 : range === "90D" ? 90 : 30;
    const start = new Date(Date.now() - (dayCount - 1) * 86_400_000);
    start.setHours(0, 0, 0, 0);
    const { data: reports, error: reportError } = await context.client
      .from("reports")
      .select("id, category, status, created_at, updated_at, verified_at")
      .gte("created_at", start.toISOString())
      .order("created_at", { ascending: true });
    if (reportError) throw reportError;

    const { data: scores, error: scoreError } = await context.client
      .from("risk_scores")
      .select("risk_level");
    if (scoreError) throw scoreError;

    const reportRows = reports ?? [];
    const countBy = (key: "category" | "status") => {
      const counts = new Map<string, number>();
      for (const report of reportRows) {
        const label = String(report[key] ?? "Unknown");
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);
    };

    const timeline = new Map<string, number>();
    for (let index = 0; index < dayCount; index += 1) {
      const date = new Date(start.getTime() + index * 86_400_000);
      timeline.set(date.toISOString().slice(0, 10), 0);
    }
    for (const report of reportRows) {
      const day = String(report.created_at).slice(0, 10);
      if (timeline.has(day)) timeline.set(day, (timeline.get(day) ?? 0) + 1);
    }

    const resolved = reportRows.filter((report) => report.status === "RESOLVED");
    const resolutionHours = resolved
      .filter((report) => report.updated_at && report.created_at)
      .map((report) =>
        Math.max(
          0,
          (new Date(String(report.updated_at)).getTime() -
            new Date(String(report.created_at)).getTime()) /
            3_600_000,
        ),
      );
    const byStatus = countBy("status");
    for (const status of [
      "PENDING_VERIFICATION",
      "VERIFIED",
      "REJECTED",
      "ASSIGNED",
      "IN_PROGRESS",
      "RESOLVED",
    ]) {
      if (!byStatus.some((item) => item.label === status)) {
        byStatus.push({ label: status, count: 0 });
      }
    }
    const verifiedCount = reportRows.filter(
      (report) =>
        report.verified_at ||
        ["VERIFIED", "ASSIGNED", "IN_PROGRESS", "RESOLVED"].includes(
          String(report.status),
        ),
    ).length;
    const riskDistribution = ["LOW", "MEDIUM", "HIGH"].map((label) => ({
      label,
      count: (scores ?? []).filter((score) => score.risk_level === label).length,
    }));

    response.json(
      GetCityAnalyticsResponse.parse({
        total_reports: reportRows.length,
        verification_rate:
          reportRows.length === 0 ? 0 : verifiedCount / reportRows.length,
        resolution_rate:
          reportRows.length === 0 ? 0 : resolved.length / reportRows.length,
        high_risk_areas: (scores ?? []).filter((score) => score.risk_level === "HIGH").length,
        average_resolution_hours:
          resolutionHours.length === 0
            ? null
            : resolutionHours.reduce((sum, value) => sum + value, 0) /
              resolutionHours.length,
        reports_over_time: [...timeline.entries()].map(([label, count]) => ({
          label,
          count,
        })),
        by_category: countBy("category"),
        by_status: byStatus,
        risk_distribution: riskDistribution,
      }),
    );
  }),
);

router.post(
  "/citypulse/assistant",
  withCityPulseErrors(async (request, response): Promise<void> => {
    const context = await requireCityPulseContext(request);
    requireCityPulseAdmin(context.profile);
    const parsed = AskCityAssistantBody.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Enter a question about city operations." });
      return;
    }

    const [reports, { data: scores, error: scoreError }, { data: predictions, error: predictionError }] =
      await Promise.all([
        getAccessibleReports(context.client, context.user.id, "ADMIN"),
        context.client.from("risk_scores").select("location_name, overall_risk, risk_level"),
        context.client
          .from("predictions")
          .select("location_name, prediction_type, probability"),
      ]);
    if (scoreError) throw scoreError;
    if (predictionError) throw predictionError;

    const categoryCounts = new Map<string, number>();
    for (const report of reports) {
      const category = String(report.category ?? "Unknown");
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    }
    const orderedScores = [...(scores ?? [])].sort(
      (a, b) => Number(b.overall_risk) - Number(a.overall_risk),
    );
    const orderedPredictions = [...(predictions ?? [])].sort(
      (a, b) => Number(b.probability) - Number(a.probability),
    );
    const stats: AssistantStats = {
      totalReports: reports.length,
      pending: reports.filter((report) => report.status === "PENDING_VERIFICATION").length,
      verified: reports.filter(
        (report) =>
          report.verified_at ||
          ["VERIFIED", "ASSIGNED", "IN_PROGRESS", "RESOLVED"].includes(
            String(report.status),
          ),
      ).length,
      inProgress: reports.filter((report) => report.status === "IN_PROGRESS").length,
      resolved: reports.filter((report) => report.status === "RESOLVED").length,
      byCategory: [...categoryCounts.entries()].map(([label, count]) => ({
        label,
        count,
      })),
      topRisk: orderedScores[0]
        ? {
            location_name: String(orderedScores[0].location_name),
            overall_risk: Number(orderedScores[0].overall_risk),
            risk_level: String(orderedScores[0].risk_level),
          }
        : null,
      topPrediction: orderedPredictions[0]
        ? {
            location_name: String(orderedPredictions[0].location_name),
            prediction_type: String(orderedPredictions[0].prediction_type),
            probability: Number(orderedPredictions[0].probability),
          }
        : null,
    };
    const answer = await answerCityPulseQuestion(parsed.data.question, stats);
    response.json(AskCityAssistantResponse.parse(answer));
  }),
);

router.get(
  "/citypulse/alerts",
  withCityPulseErrors(async (request, response): Promise<void> => {
    const context = await requireCityPulseContext(request);
    requireCityPulseAdmin(context.profile);
    const { data, error } = await context.client
      .from("alerts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    response.json(ListCityAlertsResponse.parse(data ?? []));
  }),
);

router.patch(
  "/citypulse/alerts/:alertId",
  withCityPulseErrors(async (request, response): Promise<void> => {
    const context = await requireCityPulseContext(request);
    requireCityPulseAdmin(context.profile);
    const params = UpdateCityAlertParams.safeParse(request.params);
    const body = UpdateCityAlertBody.safeParse(request.body);
    if (!params.success || !body.success) {
      response.status(400).json({ error: "Invalid alert update." });
      return;
    }
    const { data, error } = await context.client
      .from("alerts")
      .update({ read: body.data.read })
      .eq("id", params.data.alertId)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      response.status(404).json({ error: "Alert not found." });
      return;
    }
    response.json(UpdateCityAlertResponse.parse(data));
  }),
);

export default router;
