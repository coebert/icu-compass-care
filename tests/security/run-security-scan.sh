#!/usr/bin/env bash
#
# Security findings regression scan.
#
# Runs the API-only security regression tests that encode our fixed security
# findings (RLS policy enforcement, non-clinical access denial, auth guards).
# If any of these tests fail, a previously-fixed security finding has
# reappeared and the build MUST fail.
#
# These tests talk to the Data API / Auth API directly (no browser), so they
# run in CI with only the Supabase service + publishable credentials.
#
# Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
set -euo pipefail

cd "$(dirname "$0")/../.."

for var in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_PUBLISHABLE_KEY; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set — cannot run the security findings scan." >&2
    exit 1
  fi
done

# Curated list of API-only tests that guard fixed security findings.
TESTS=(
  "tests/e2e/rls-fixed-policies-block-public-enforce-clinical.e2e.py"
  "tests/e2e/non-clinical-api-read-update-dnacpr-escalation-rejected.e2e.py"
  "tests/e2e/non-clinical-dnacpr-update-not-persisted.e2e.py"
  "tests/e2e/non-clinical-escalation-plan-update-not-persisted.e2e.py"
  "tests/e2e/non-clinical-status-change-rejected.e2e.py"
  "tests/e2e/non-clinical-user-cannot-read-versions-or-write-field-changes.e2e.py"
  "tests/e2e/non-clinical-user-cannot-view-or-modify-outlier-patient.e2e.py"
  "tests/e2e/non-clinical-user-write-field-changes-clear-authz-error.e2e.py"
  "tests/e2e/dnacpr-data-api-visible-clinical-omitted-nonclinical.e2e.py"
  "tests/e2e/tep-data-api-nonclinical-no-read-no-write.e2e.py"
)

failed=()
for t in "${TESTS[@]}"; do
  echo "=== Running $t ==="
  if python3 "$t"; then
    echo "PASS: $t"
  else
    echo "FAIL: $t"
    failed+=("$t")
  fi
  echo
done

if [ "${#failed[@]}" -ne 0 ]; then
  echo "SECURITY SCAN FAILED — findings reappeared in:" >&2
  for t in "${failed[@]}"; do echo "  - $t" >&2; done
  exit 1
fi

echo "SECURITY SCAN PASSED — no security findings reappeared."
