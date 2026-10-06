# CityPulse

CityPulse is a civic reporting and operations prototype. Residents can submit and follow reports; city staff can verify reports, record actions, review aggregate risk signals, and query the decision-support assistant.

## Supabase setup

1. In the linked Supabase project, open **SQL Editor** and run `supabase/migrations/202610060001_citypulse.sql`.
2. In Replit Secrets, configure `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. The first two are browser-visible; the service-role key must remain server-only.
3. Optionally configure `GEMINI_API_KEY` for Gemini report analysis and the assistant. Without it, CityPulse uses a limited deterministic fallback and labels its output accordingly.
4. Create an account through `/signup`. New accounts are always `CITIZEN`; there is no public administrator signup.
5. To promote a trusted account to administrator, run this manually in Supabase SQL Editor after account creation:

   ```sql
   update public.profiles
   set role = 'ADMIN'
   where lower(email) = lower('your-admin-email@example.com');
   ```

   Confirm that exactly one profile was updated. The application and database both check the stored profile role for administrator actions.

The migration creates the private `report-images` bucket, storage policies, tables, indexes, and profile trigger. It also seeds synthetic sample reports, risk scores, alerts, and forecasts so the prototype has something to display. These rows are marked as simulated and are not official city records or emergency alerts. Remove or replace the sample records before treating the deployment as an operational city service.

## Data and safety notes

- New citizen reports always begin as `PENDING_VERIFICATION`.
- Gemini analysis is advisory and never changes a report status or verifies a report.
- Only a staff action can verify, reject, assign, advance, or resolve a report; each action is recorded with its administrator and notes.
- Active verified reports feed the prototype risk calculation. Resolved and rejected reports do not.
- Report images are stored privately. The browser requests short-lived signed URLs only for reports the signed-in user or an administrator may access.
- Forecasts and risk values are prototype indicators. Do not use them as emergency dispatch or public-safety decisions.
