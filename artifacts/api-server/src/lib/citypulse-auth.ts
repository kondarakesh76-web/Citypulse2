import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { Request } from "express";

export type CityPulseProfile = {
  id: string;
  full_name: string;
  email: string;
  role: "CITIZEN" | "ADMIN";
};

export type CityPulseContext = {
  client: SupabaseClient;
  user: User;
  profile: CityPulseProfile;
};

export class CityPulseHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CityPulseHttpError";
  }
}

let cachedAdminClient: SupabaseClient | undefined;

export function getCityPulseAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new CityPulseHttpError(
      503,
      "CityPulse is not connected to Supabase yet. Check the project setup instructions.",
    );
  }

  if (!cachedAdminClient) {
    cachedAdminClient = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  }

  return cachedAdminClient;
}

export async function requireCityPulseContext(
  request: Request,
): Promise<CityPulseContext> {
  const authorization = request.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);

  if (!match?.[1]) {
    throw new CityPulseHttpError(401, "Sign in to continue.");
  }

  const client = getCityPulseAdminClient();
  const {
    data: { user },
    error: authError,
  } = await client.auth.getUser(match[1]);

  if (authError || !user) {
    throw new CityPulseHttpError(401, "Your session has expired. Sign in again.");
  }

  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("id, full_name, email, role")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    if (profileError.code === "42P01" || profileError.code === "PGRST205") {
      throw new CityPulseHttpError(
        503,
        "The CityPulse database schema is not installed. Apply the included Supabase migration.",
      );
    }
    throw profileError;
  }

  if (!profile || (profile.role !== "CITIZEN" && profile.role !== "ADMIN")) {
    throw new CityPulseHttpError(
      403,
      "Your CityPulse profile is not ready. Please contact an administrator.",
    );
  }

  return {
    client,
    user,
    profile: profile as CityPulseProfile,
  };
}

export function requireCityPulseAdmin(profile: CityPulseProfile): void {
  if (profile.role !== "ADMIN") {
    throw new CityPulseHttpError(403, "Administrator access is required.");
  }
}
