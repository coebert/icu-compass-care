// Maps raw database/Supabase errors to a safe, generic client-facing message.
// The full error detail is logged server-side only so schema/table/constraint
// names are never leaked to the browser or to external bridge callers.
export function safeDbError(error: unknown, action = "complete that action"): Error {
  console.error(`[db-error] failed to ${action}:`, error);
  return new Error(`Something went wrong while trying to ${action}. Please try again.`);
}
