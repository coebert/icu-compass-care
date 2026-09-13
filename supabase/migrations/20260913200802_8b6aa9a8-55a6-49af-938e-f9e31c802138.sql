-- Trust administrators gain clinical WRITE rights everywhere (previously
-- view-only break-glass). Unit membership still constrains clinicians and unit
-- administrators; auditors remain excluded from clinical data entirely.
CREATE OR REPLACE FUNCTION private.can_edit_unit(_user_id uuid, _unit_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT (private.has_clinical_access(_user_id)
          AND private.is_unit_member(_user_id, _unit_id))
      OR private.is_trust_admin(_user_id);
$$;
