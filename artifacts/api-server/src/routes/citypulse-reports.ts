import { Router, type IRouter } from "express";
import {
  AnalyzeCityReportBody,
  AnalyzeCityReportResponse,
  CreateCityReportBody,
  CreateCityReportResponse,
  GetCityReportParams,
  GetCityReportResponse,
  ListCityReportsQueryParams,
  ListCityReportsResponse,
  UpdateCityReportStatusBody,
  UpdateCityReportStatusParams,
  UpdateCityReportStatusResponse,
} from "@workspace/api-zod";
import {
  getCityPulseAdminClient,
  requireCityPulseAdmin,
  requireCityPulseContext,
} from "../lib/citypulse-auth";
import { withCityPulseErrors } from "../lib/citypulse-errors";
import { analyzeCityPulseReport } from "../lib/citypulse-ai";
import { recalculateRiskForLocation } from "../lib/citypulse-risk";

const router: IRouter = Router();
const statuses = new Set([
  "PENDING_VERIFICATION",
  "VERIFIED",
  "REJECTED",
  "ASSIGNED",
  "IN_PROGRESS",
  "RESOLVED",
]);

type SimilarityCandidate = {
  id: string;
  title: string;
  description: string;
  location_name: string | null;
  latitude: number | null;
  longitude: number | null;
  evidence_count: number;
};

function tokenSimilarity(left: string, right: string): number {
  const tokens = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((token) => token.length > 2),
    );
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  const overlap = [...a].filter((token) => b.has(token)).length;
  return overlap / new Set([...a, ...b]).size;
}

function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const radians = (value: number) => (value * Math.PI) / 180;
  const deltaLat = radians(lat2 - lat1);
  const deltaLon = radians(lon2 - lon1);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(radians(lat1)) *
      Math.cos(radians(lat2)) *
      Math.sin(deltaLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function findPossibleDuplicate(
  client: ReturnType<typeof getCityPulseAdminClient>,
  input: {
    category: string;
    title: string;
    description: string;
    location_name?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  },
): Promise<SimilarityCandidate | null> {
  const windowStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from("reports")
    .select("id, title, description, location_name, latitude, longitude, evidence_count")
    .eq("category", input.category)
    .eq("is_demo", false)
    .neq("status", "REJECTED")
    .gte("created_at", windowStart)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;

  const candidates = (data ?? []) as SimilarityCandidate[];
  const currentText = `${input.title} ${input.description}`;
  for (const candidate of candidates) {
    const textMatch =
      tokenSimilarity(
        currentText,
        `${candidate.title} ${candidate.description}`,
      ) >= 0.52;
    const locationMatch =
      input.latitude != null &&
      input.longitude != null &&
      candidate.latitude != null &&
      candidate.longitude != null
        ? distanceMeters(
            input.latitude,
            input.longitude,
            candidate.latitude,
            candidate.longitude,
          ) <= 300
        : Boolean(
            input.location_name &&
              candidate.location_name &&
              input.location_name.trim().toLowerCase() ===
                candidate.location_name.trim().toLowerCase(),
          );

    if (textMatch || locationMatch) return candidate;
  }

  return null;
}

router.get(
  "/citypulse/reports",
  withCityPulseErrors(async (request, response): Promise<void> => {
    const context = await requireCityPulseContext(request);
    const parsed = ListCityReportsQueryParams.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid report filters." });
      return;
    }
    const { status, category, search, limit } = parsed.data;
    if (status && !statuses.has(status)) {
      response.status(400).json({ error: "Unknown report status." });
      return;
    }

    let query = context.client
      .from("reports")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit ?? 100);

    if (context.profile.role !== "ADMIN") {
      query = query.eq("user_id", context.user.id).eq("is_demo", false);
    }
    if (status) query = query.eq("status", status);
    if (category) query = query.eq("category", category);

    const { data, error } = await query;
    if (error) throw error;

    const normalized = (data ?? []).filter((report) => {
      if (!search) return true;
      const needle = search.toLowerCase();
      return (
        String(report.title ?? "").toLowerCase().includes(needle) ||
        String(report.description ?? "").toLowerCase().includes(needle) ||
        String(report.location_name ?? "").toLowerCase().includes(needle)
      );
    });
    response.json(ListCityReportsResponse.parse(normalized));
  }),
);

router.post(
  "/citypulse/reports/analyze",
  withCityPulseErrors(async (request, response): Promise<void> => {
    await requireCityPulseContext(request);
    const parsed = AnalyzeCityReportBody.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Check the report details and try again." });
      return;
    }

    const result = await analyzeCityPulseReport(parsed.data);
    const possibleDuplicate = await findPossibleDuplicate(
      getCityPulseAdminClient(),
      parsed.data,
    );
    response.json(
      AnalyzeCityReportResponse.parse({
        ...result,
        possible_duplicate: Boolean(possibleDuplicate),
        duplicate_of: possibleDuplicate?.id ?? null,
      }),
    );
  }),
);

router.post(
  "/citypulse/reports",
  withCityPulseErrors(async (request, response): Promise<void> => {
    const context = await requireCityPulseContext(request);
    const parsed = CreateCityReportBody.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Check the report details and try again." });
      return;
    }

    const input = parsed.data;
    if (
      input.image_url &&
      (!input.image_url.startsWith(`${context.user.id}/`) ||
        input.image_url.includes("..") ||
        input.image_url.includes("\\"))
    ) {
      response.status(400).json({
        error: "Evidence must be uploaded to your own private CityPulse folder.",
      });
      return;
    }
    const [analysis, duplicate] = await Promise.all([
      analyzeCityPulseReport(input),
      findPossibleDuplicate(context.client, input),
    ]);
    const reportRecord = {
      user_id: context.user.id,
      category: input.category,
      title: input.title.trim(),
      description: input.description.trim(),
      image_url: input.image_url ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      location_name: input.location_name?.trim() || null,
      severity: input.severity,
      status: "PENDING_VERIFICATION",
      ai_confidence: analysis.confidence,
      ai_category: analysis.category,
      ai_summary: analysis.summary,
      suspicious: analysis.suspicious,
      duplicate_of: duplicate?.id ?? null,
      evidence_count: 1,
      is_demo: false,
    };
    const { data, error } = await context.client
      .from("reports")
      .insert(reportRecord)
      .select("*")
      .single();
    if (error) throw error;

    if (duplicate) {
      const { error: evidenceError } = await context.client
        .from("reports")
        .update({
          evidence_count: (duplicate.evidence_count ?? 1) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", duplicate.id);
      if (evidenceError) {
        request.log.warn(
          { reportId: data.id, duplicateId: duplicate.id },
          "Could not increment duplicate evidence count",
        );
      }
    }

    const { error: alertError } = await context.client.from("alerts").insert({
      title: "NEW REPORT REQUIRES VERIFICATION",
      message: `${input.category} report received: ${input.title.trim()}`,
      severity: input.severity,
      location_name: input.location_name?.trim() || "Citywide",
      related_report_id: data.id,
    });
    if (alertError) {
      request.log.warn({ reportId: data.id }, "Could not create report alert");
    }

    response.status(201).json(CreateCityReportResponse.parse(data));
  }),
);

router.get(
  "/citypulse/reports/:reportId",
  withCityPulseErrors(async (request, response): Promise<void> => {
    const context = await requireCityPulseContext(request);
    const params = GetCityReportParams.safeParse(request.params);
    if (!params.success) {
      response.status(400).json({ error: "Invalid report." });
      return;
    }

    let query = context.client
      .from("reports")
      .select("*")
      .eq("id", params.data.reportId);
    if (context.profile.role !== "ADMIN") {
      query = query.eq("user_id", context.user.id).eq("is_demo", false);
    }
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data) {
      response.status(404).json({ error: "Report not found." });
      return;
    }
    response.json(GetCityReportResponse.parse(data));
  }),
);

router.patch(
  "/citypulse/reports/:reportId/status",
  withCityPulseErrors(async (request, response): Promise<void> => {
    const context = await requireCityPulseContext(request);
    requireCityPulseAdmin(context.profile);

    const params = UpdateCityReportStatusParams.safeParse(request.params);
    const body = UpdateCityReportStatusBody.safeParse(request.body);
    if (!params.success || !body.success) {
      response.status(400).json({ error: "Invalid report action." });
      return;
    }

    const { data, error } = await context.client.rpc(
      "citypulse_apply_admin_report_action",
      {
        p_report_id: params.data.reportId,
        p_admin_id: context.user.id,
        p_status: body.data.status,
        p_notes: body.data.notes ?? null,
      },
    );
    if (error) {
      if (error.code === "P0002") {
        response.status(404).json({ error: "Report not found." });
        return;
      }
      if (error.code === "22023") {
        response.status(409).json({
          error: "That action is not available for the report’s current status.",
        });
        return;
      }
      throw error;
    }

    const result = UpdateCityReportStatusResponse.parse(data);
    const locationName = result.report.location_name;
    if (locationName) {
      await recalculateRiskForLocation(context.client, locationName);
    }

    response.json(result);
  }),
);

export default router;
