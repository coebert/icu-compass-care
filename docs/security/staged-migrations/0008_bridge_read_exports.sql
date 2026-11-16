-- =============================================================================
-- STAGED — NOT APPLIED. Do not copy into drizzle/migrations or run until the
-- coordinated release gate authorises it (docs/security/deployment-sequencing.md).
-- Depends on: 0006 (private.bridge_unit_id). Apply 0005, 0006, 0007, 0008 in order.
--
-- Partner (Critical Care Connect) clinical READ exports. Each function returns
-- clinical rows only when, IN THE SAME STATEMENT that reads them, the parent
-- patient is in the bridge unit (code SDH-RADNOR, resolved here, never passed
-- in) and is still shared_with_partner. There is no earlier list of allowed
-- ids: a revocation committed before the call is always honoured.
--
-- * Child results (investigations, microbiology): parent = patient_id.
-- * Referral feeds (referrals, notifications): parent = a shared bridge-unit
--   patient whose source_referral_id is that referral.
-- * Audit: typed. A 'patients' entry needs a shared bridge-unit patient with
--   that id; a 'referrals' entry needs one whose source_referral_id is that
--   id. A UUID that happens to match the other kind is never enough.
--
-- Every function: SECURITY DEFINER, empty search_path, STABLE (one snapshot
-- for the whole call), EXECUTE for service_role only. Row types are the
-- table's own, so the partner response keys are unchanged. A missing or
-- duplicated bridge unit raises (PT503); the API turns that into "unavailable",
-- never an empty list.
--
-- Non-destructive: adds functions only. No table, grant on a table, or row is
-- changed.
-- =============================================================================

-- Preflight: the bridge unit helper from 0006 must exist and resolve.
DO $$
BEGIN
  PERFORM private.bridge_unit_id();
END $$;

CREATE OR REPLACE FUNCTION public.bridge_export_investigations(
  _patient_id uuid DEFAULT NULL,
  _category text DEFAULT NULL
)
RETURNS SETOF public.investigations
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_unit uuid := private.bridge_unit_id();
BEGIN
  RETURN QUERY
    SELECT i.*
      FROM public.investigations i
     WHERE EXISTS (
             SELECT 1 FROM public.patients p
              WHERE p.id = i.patient_id
                AND p.unit_id = v_unit
                AND p.shared_with_partner IS TRUE)
       AND (_patient_id IS NULL OR i.patient_id = _patient_id)
       AND (_category IS NULL OR i.category = _category)
     ORDER BY i.result_at DESC, i.id;
END
$$;

CREATE OR REPLACE FUNCTION public.bridge_export_microbiology()
RETURNS SETOF public.microbiology_results
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_unit uuid := private.bridge_unit_id();
BEGIN
  RETURN QUERY
    SELECT m.*
      FROM public.microbiology_results m
     WHERE EXISTS (
             SELECT 1 FROM public.patients p
              WHERE p.id = m.patient_id
                AND p.unit_id = v_unit
                AND p.shared_with_partner IS TRUE)
     ORDER BY m.updated_at DESC, m.id
     LIMIT 5000;
END
$$;

CREATE OR REPLACE FUNCTION public.bridge_export_referrals()
RETURNS SETOF public.referrals
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_unit uuid := private.bridge_unit_id();
BEGIN
  RETURN QUERY
    SELECT r.*
      FROM public.referrals r
     WHERE EXISTS (
             SELECT 1 FROM public.patients p
              WHERE p.source_referral_id = r.id
                AND p.unit_id = v_unit
                AND p.shared_with_partner IS TRUE)
     ORDER BY r.updated_at DESC, r.id
     LIMIT 2000;
END
$$;

CREATE OR REPLACE FUNCTION public.bridge_export_notifications()
RETURNS SETOF public.notifications
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_unit uuid := private.bridge_unit_id();
BEGIN
  RETURN QUERY
    SELECT n.*
      FROM public.notifications n
     WHERE n.referral_id IS NOT NULL
       AND EXISTS (
             SELECT 1 FROM public.patients p
              WHERE p.source_referral_id = n.referral_id
                AND p.unit_id = v_unit
                AND p.shared_with_partner IS TRUE)
     ORDER BY n.created_at DESC, n.id
     LIMIT 2000;
END
$$;

CREATE OR REPLACE FUNCTION public.bridge_export_audit()
RETURNS SETOF public.audit_log
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_unit uuid := private.bridge_unit_id();
BEGIN
  RETURN QUERY
    SELECT a.*
      FROM public.audit_log a
     WHERE a.entity_id IS NOT NULL
       AND (
             (a.entity = 'patients' AND EXISTS (
                SELECT 1 FROM public.patients p
                 WHERE p.id = a.entity_id
                   AND p.unit_id = v_unit
                   AND p.shared_with_partner IS TRUE))
          OR (a.entity = 'referrals' AND EXISTS (
                SELECT 1 FROM public.patients p
                 WHERE p.source_referral_id = a.entity_id
                   AND p.unit_id = v_unit
                   AND p.shared_with_partner IS TRUE))
           )
     ORDER BY a.created_at DESC, a.id
     LIMIT 2000;
END
$$;

REVOKE ALL ON FUNCTION public.bridge_export_investigations(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bridge_export_microbiology() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bridge_export_referrals() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bridge_export_notifications() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bridge_export_audit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_export_investigations(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.bridge_export_microbiology() TO service_role;
GRANT EXECUTE ON FUNCTION public.bridge_export_referrals() TO service_role;
GRANT EXECUTE ON FUNCTION public.bridge_export_notifications() TO service_role;
GRANT EXECUTE ON FUNCTION public.bridge_export_audit() TO service_role;
