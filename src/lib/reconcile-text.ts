// Client-safe wording for the cross-app sync review page.
import type { ReconReason, ReconRow } from "@/lib/reconcile.functions";

export const RECON_REASON_TEXT: Record<ReconReason, string> = {
  new_on_partner: "New in Critical Care Connect. Pulling brings it in through the checked import.",
  partner_deletion:
    "Removed in Critical Care Connect. Pulling records the removal here; no copy of the referral is made.",
  partner_newer:
    "Critical Care Connect has a newer version. Pulling updates the copy here through the checked import.",
  not_imported:
    "The copy here wasn't brought in by the checked import (an older copy, or made here). Pulling won't change it. Compare both copies and correct it by hand if needed.",
  local_edit:
    "Changed here since it was imported. Pulling won't overwrite it. Compare both copies and correct it by hand if needed.",
  local_missing:
    "Was imported earlier but is no longer here. Pulling won't recreate it. Check what happened to it here.",
  watermark_reused:
    "A record here uses the id of a referral that Critical Care Connect removed. Pulling won't change it. Review it here.",
  partner_not_newer:
    "The copies differ, but Critical Care Connect's isn't newer than what was imported. Pulling won't change it. Check the referral in Critical Care Connect.",
  deletion_stands:
    "Critical Care Connect is showing an older version of a referral it has removed. The removal stands here. Check the referral in Critical Care Connect.",
  imported_not_listed:
    "Imported earlier, but no longer in Critical Care Connect's list. The copy here is kept.",
  local_record:
    "Only in this app. This app keeps its own records, so nothing needs sending.",
  partner_list_unconfirmed:
    "Not in the partner's list, but the partner didn't confirm its list is complete.",
  review_only: "Review only. Not copied into this app.",
};

export const RECON_STATE_LABEL: Record<ReconRow["state"], string> = {
  matched: "Matched",
  diverged: "Newer on partner",
  remote_only: "Only on partner",
  local_only: "Only here",
  conflict: "Needs review",
  held: "Differs",
};

export type LoadErrorKind = "denied" | "session" | "offline" | "failed";

/** Tell "you may not see this" apart from "it didn't load"; never echo raw text. */
export function classifyLoadError(e: unknown, online = true): LoadErrorKind {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (/^Forbidden\b/.test(msg)) return "denied";
  if (/^SESSION_(LOCKED|ENDED)\b/.test(msg)) return "session";
  if (!online) return "offline";
  return "failed";
}

export const LOAD_ERROR_TEXT: Record<LoadErrorKind, string> = {
  denied: "Only Trust administrators can review cross-project sync.",
  session: "Your session needs to be unlocked or renewed before the comparison can load.",
  offline: "You appear to be offline, so the comparison couldn't load.",
  failed: "The comparison couldn't load right now. Nothing has been changed.",
};
