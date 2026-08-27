-- ===========================================================================
-- Role-based access control matching Critical_Care_Permission_Matrix_v1.docx
-- Roles: clinician | unit_admin | trust_admin | auditor  (legacy: admin)
-- ===========================================================================

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'unit_admin';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'trust_admin';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'auditor';
