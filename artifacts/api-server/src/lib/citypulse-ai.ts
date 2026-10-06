import { AnalyzeCityReportResponse, AskCityAssistantResponse } from "@workspace/api-zod";

export type CityPulseAnalysisInput = {
  category: string;
  title: string;
  description: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
  location_name?: string | null;
};

export type CityPulseAnalysis = {
  category: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
  confidence: number;
  summary: string;
  suspicious: boolean;
  possible_duplicate: boolean;
  duplicate_of: string | null;
  verification_priority: "LOW" | "MEDIUM" | "HIGH";
  source: "gemini" | "fallback";
};

const validCategories = [
  "Traffic",
  "Flooding",
  "Road Damage",
  "Garbage",
  "Streetlight",
  "Pollution",
  "Infrastructure",
];

function fallbackAnalysis(input: CityPulseAnalysisInput): CityPulseAnalysis {
  const compact = `${input.title} ${input.description}`.trim();
  const distinctWords = new Set(
    compact.toLowerCase().match(/[a-z0-9]+/g) ?? [],
  ).size;
  const suspicious = distinctWords < 4 || input.description.length < 18;

  return {
    category: validCategories.includes(input.category)
      ? input.category
      : "Infrastructure",
    severity: input.severity,
    confidence: suspicious ? 0.56 : 0.72,
    summary: `Reported ${input.category.toLowerCase()} issue${input.location_name ? ` near ${input.location_name}` : ""}. Human verification is required before it affects city risk scores.`,
    suspicious,
    possible_duplicate: false,
    duplicate_of: null,
    verification_priority: input.severity,
    source: "fallback",
  };
}

function extractJsonText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || !candidates[0]) return null;
  const content = (candidates[0] as { content?: { parts?: unknown } }).content;
  if (!content || !Array.isArray(content.parts)) return null;
  const text = content.parts
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
  return text || null;
}

export async function analyzeCityPulseReport(
  input: CityPulseAnalysisInput,
): Promise<CityPulseAnalysis> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fallbackAnalysis(input);

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: [
                    "Analyze this citizen report as decision support only. Do not verify it or change its workflow status. Keep the status pending for a human administrator.",
                    "Return only a JSON object with category, severity, confidence (0 to 1), summary (under 240 characters), suspicious (boolean), and verification_priority (LOW, MEDIUM, or HIGH).",
                    `Allowed categories: ${validCategories.join(", ")}.`,
                    `Input report: ${JSON.stringify(input)}`,
                  ].join("\n"),
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: 8192,
          },
        }),
      },
    );

    if (!response.ok) return fallbackAnalysis(input);
    const text = extractJsonText(await response.json());
    if (!text) return fallbackAnalysis(input);

    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return fallbackAnalysis(input);
    const candidate = parsed as Record<string, unknown>;
    const candidateCategory =
      typeof candidate.category === "string" &&
      validCategories.includes(candidate.category)
        ? candidate.category
        : null;
    const safe = AnalyzeCityReportResponse.safeParse({
      category: candidateCategory,
      severity: candidate.severity,
      confidence: candidate.confidence,
      summary: candidate.summary,
      suspicious: candidate.suspicious,
      possible_duplicate: false,
      duplicate_of: null,
      verification_priority: candidate.verification_priority,
      source: "gemini",
    });

    if (!safe.success) return fallbackAnalysis(input);
    return safe.data as CityPulseAnalysis;
  } catch {
    return fallbackAnalysis(input);
  }
}

export type AssistantStats = {
  totalReports: number;
  pending: number;
  verified: number;
  inProgress: number;
  resolved: number;
  byCategory: Array<{ label: string; count: number }>;
  topRisk: {
    location_name: string;
    overall_risk: number;
    risk_level: string;
  } | null;
  topPrediction: {
    location_name: string;
    prediction_type: string;
    probability: number;
  } | null;
};

function fallbackAssistant(stats: AssistantStats) {
  const mostReported = [...stats.byCategory].sort(
    (a, b) => b.count - a.count,
  )[0];
  return {
    verified_data: `${stats.totalReports} accessible reports: ${stats.pending} pending verification, ${stats.verified} verified, ${stats.inProgress} in progress, and ${stats.resolved} resolved.`,
    analysis: mostReported
      ? `${mostReported.label} is the most reported category in the available records (${mostReported.count} reports).`
      : "There are not enough reports to identify a leading category.",
    prediction: stats.topPrediction
      ? `${stats.topPrediction.prediction_type} is listed for ${stats.topPrediction.location_name} at ${Math.round(stats.topPrediction.probability * 100)}% in the prototype forecast.`
      : "No forecast is available from the current data.",
    recommendation: stats.topRisk
      ? `Review verified evidence in ${stats.topRisk.location_name}, the highest currently listed risk area, before assigning field work.`
      : "Verify pending reports before prioritizing field work.",
    source: "fallback" as const,
  };
}

export async function answerCityPulseQuestion(
  question: string,
  stats: AssistantStats,
) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fallbackAssistant(stats);

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: [
                    "You are CityPulse AI, a city-operations decision-support assistant. Never claim to contact authorities or make decisions.",
                    "Answer only from the JSON data supplied below. Do not invent numbers, locations, report details, or evidence. State when data is unavailable.",
                    "Return only strict JSON with string fields: verified_data, analysis, prediction, recommendation.",
                    `Current authorized database summary: ${JSON.stringify(stats)}`,
                    `Question: ${question}`,
                  ].join("\n"),
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: 8192,
          },
        }),
      },
    );

    if (!response.ok) return fallbackAssistant(stats);
    const text = extractJsonText(await response.json());
    if (!text) return fallbackAssistant(stats);

    const candidate: unknown = JSON.parse(text);
    if (!candidate || typeof candidate !== "object") return fallbackAssistant(stats);
    const safe = AskCityAssistantResponse.safeParse({
      ...(candidate as Record<string, unknown>),
      source: "gemini",
    });
    return safe.success ? safe.data : fallbackAssistant(stats);
  } catch {
    return fallbackAssistant(stats);
  }
}
