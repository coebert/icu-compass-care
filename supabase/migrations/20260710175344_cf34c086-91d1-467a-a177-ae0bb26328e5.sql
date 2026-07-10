-- Allow authenticated users to execute the SECURITY DEFINER role-check helpers
-- used inside RLS policies. Without USAGE on the `private` schema and EXECUTE on
-- these functions, any policy that calls private.has_role(...) errors with
-- "permission denied for function has_role" when evaluated as the authenticated
-- role. That breaks own-role reads (getMe), staff administration, and sync
-- reconciliation for every signed-in user, so admins can never be recognised.
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.has_role(uuid, app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION private.has_clinical_access(uuid) TO authenticated;