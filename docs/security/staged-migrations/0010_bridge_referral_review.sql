-- =============================================================================
-- STAGED — NOT APPLIED. Do not copy into drizzle/migrations or run until the
-- coordinated release gate authorises it (docs/security/deployment-sequencing.md).
-- Depends on: 0006 (private.bridge_referral_provenance, referral_import_fields).
-- Apply after 0009.
--
-- Read-only helper for the Trust-administrator cross-app review page.
-- Returns, in ONE statement (one snapshot), every referral id known here —
-- local rows and import-ledger entries, including tombstone watermarks for
-- referrals never imported — with:
--   * the allowlisted comparable content (same fields the import may write);
--   * whether the import ledger trusts the local row: receiver_matches is
--     true only when the local row is still exactly what the import last
--     wrote. Ledger internals (receiver revision) are never returned.
-- The result is one jsonb value, so a REST row cap (max_rows) can't silently
-- shorten it. If more than _limit ids exist, rows are withheld and
-- complete=false, so the page can't claim "matched" or "only on one side"
-- from a partial list.
-- Service role only. Writes nothing; changes no rows. Non-destructive.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.bridge_referral_review(_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n int;
  v_rows jsonb;
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 10000 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = 'PT400';
  END IF;
  WITH ids AS (
    SELECT r.id FROM public.referrals r
    UNION
    SELECT p.referral_id FROM private.bridge_referral_provenance p
  ), page AS (
    SELECT i.id FROM ids i ORDER BY i.id LIMIT _limit + 1
  )
  SELECT (SELECT count(*)::int FROM page),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', pg.id,
           'local', CASE WHEN r.id IS NULL THEN NULL ELSE private.referral_import_fields(r) END,
           'local_updated_at', r.updated_at,
           'provenance', CASE WHEN p.referral_id IS NULL THEN NULL ELSE jsonb_build_object(
             'source_revision', p.source_revision,
             'watermark', p.receiver_revision IS NULL,
             'receiver_matches', r.id IS NOT NULL AND p.receiver_revision IS NOT NULL
                                 AND r.updated_at = p.receiver_revision) END
         ) ORDER BY pg.id), '[]'::jsonb)
    INTO v_n, v_rows
    FROM (SELECT id FROM page ORDER BY id LIMIT _limit) pg
    LEFT JOIN public.referrals r ON r.id = pg.id
    LEFT JOIN private.bridge_referral_provenance p ON p.referral_id = pg.id;
  IF v_n > _limit THEN
    RETURN jsonb_build_object('complete', false, 'rows', '[]'::jsonb);
  END IF;
  RETURN jsonb_build_object('complete', true, 'rows', v_rows);
END
$$;
REVOKE ALL ON FUNCTION public.bridge_referral_review(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_referral_review(integer) TO service_role;
