import type { SupabaseClient } from "@supabase/supabase-js";

const riskLevel = (score: number): "LOW" | "MEDIUM" | "HIGH" => {
  if (score >= 70) return "HIGH";
  if (score >= 40) return "MEDIUM";
  return "LOW";
};

const clamp = (value: number) => Math.min(100, Math.max(0, Math.round(value)));

export async function recalculateRiskForLocation(
  client: SupabaseClient,
  locationName: string,
): Promise<void> {
  const { data: current, error: scoreError } = await client
    .from("risk_scores")
    .select("*")
    .eq("location_name", locationName)
    .maybeSingle();

  if (scoreError) throw scoreError;

  const { data: verifiedReports, error: reportsError } = await client
    .from("reports")
    .select("category, latitude, longitude")
    .eq("location_name", locationName)
    .not("verified_at", "is", null)
    .not("status", "in", "(REJECTED,RESOLVED)");

  if (reportsError) throw reportsError;

  const reports = verifiedReports ?? [];
  const activeVerifiedCount = reports.length;
  const reportRisk = clamp(activeVerifiedCount * 12);
  const traffic = current?.traffic_risk ?? 30;
  const flood = current?.flood_risk ?? 25;
  const infrastructure = current?.infrastructure_risk ?? 25;
  const pollution = current?.pollution_risk ?? 20;
  const overall = clamp(
    traffic * 0.3 +
      flood * 0.25 +
      infrastructure * 0.2 +
      pollution * 0.15 +
      reportRisk * 0.1,
  );

  const coordinates = reports.find(
    (report) => report.latitude != null && report.longitude != null,
  );
  const scoreRecord = {
    location_name: locationName,
    latitude: current?.latitude ?? coordinates?.latitude ?? 0,
    longitude: current?.longitude ?? coordinates?.longitude ?? 0,
    traffic_risk: traffic,
    flood_risk: flood,
    infrastructure_risk: infrastructure,
    pollution_risk: pollution,
    verified_report_risk: reportRisk,
    overall_risk: overall,
    risk_level: riskLevel(overall),
    calculated_at: new Date().toISOString(),
  };

  const { error: upsertError } = await client
    .from("risk_scores")
    .upsert(scoreRecord, { onConflict: "location_name" });
  if (upsertError) throw upsertError;

  if (reports.length === 0) {
    const { error: deletePredictionsError } = await client
      .from("predictions")
      .delete()
      .eq("location_name", locationName);
    if (deletePredictionsError) throw deletePredictionsError;
    return;
  }

  const categoryCounts = new Map<string, number>();
  for (const report of reports) {
    const category = report.category ?? "Infrastructure";
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }
  const dominantCategory = [...categoryCounts.entries()].sort(
    (a, b) => b[1] - a[1],
  )[0]?.[0];
  const predictionType =
    dominantCategory === "Traffic"
      ? "Potential traffic congestion"
      : dominantCategory === "Flooding"
        ? "Potential localized water pooling"
        : dominantCategory === "Garbage"
          ? "Potential waste overflow"
          : `Potential ${dominantCategory?.toLowerCase() ?? "infrastructure"} issue`;
  const factors = [
    `${activeVerifiedCount} active verified report${activeVerifiedCount === 1 ? "" : "s"} in this area`,
    `prototype overall risk is ${overall}`,
    `${dominantCategory ?? "Infrastructure"} is the leading verified category`,
  ];
  const probability = Math.min(
    0.95,
    Math.max(0.2, Math.round((0.25 + overall * 0.0065) * 100) / 100),
  );
  const { error: predictionError } = await client.from("predictions").upsert(
    {
      location_name: locationName,
      prediction_type: predictionType,
      probability,
      expected_start: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      expected_end: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
      contributing_factors: factors,
      recommendation:
        dominantCategory === "Traffic"
          ? "Inspect traffic flow and road condition."
          : dominantCategory === "Flooding"
            ? "Check drainage and clear nearby inlets."
            : "Review the verified reports and schedule a site inspection.",
    },
    { onConflict: "location_name,prediction_type" },
  );

  if (predictionError) throw predictionError;
}
