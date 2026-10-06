import type { RequestHandler } from "express";
import { CityPulseHttpError } from "./citypulse-auth";

export function withCityPulseErrors(handler: RequestHandler): RequestHandler {
  return async (request, response, next) => {
    try {
      await handler(request, response, next);
    } catch (error) {
      if (error instanceof CityPulseHttpError) {
        response.status(error.status).json({ error: error.message });
        return;
      }

      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "";
      if (code === "42P01" || code === "PGRST205") {
        response.status(503).json({
          error: "The CityPulse database schema is not installed. Apply the included Supabase migration.",
        });
        return;
      }

      request.log.error({ err: error }, "CityPulse request failed");
      response.status(500).json({
        error: "CityPulse could not complete that request. Please try again.",
      });
    }
  };
}
