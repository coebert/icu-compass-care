import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeDbError } from "@/lib/db-error";

// `@simplewebauthn/server` pulls in tslib-based CommonJS deps
// (@peculiar/asn1-*, tsyringe, pvtsutils) whose ESM interop breaks when
// evaluated at module scope inside the Cloudflare Worker bundle
// ("Cannot destructure property '__extends' of __toESM(...).default"). A
// top-level import here poisons worker initialisation and 500s every server
// route. Load it lazily inside each handler so it is only evaluated when a
// passkey endpoint is actually invoked.
async function loadWebauthn() {
  const [mod, helpers] = await Promise.all([
    import("@simplewebauthn/server"),
    import("@simplewebauthn/server/helpers"),
  ]);
  return { ...mod, isoBase64URL: helpers.isoBase64URL };
}

// Derive the Relying Party origin + ID from the incoming request. WebAuthn
// binds credentials to the exact host, so this must reflect the live domain.
function getRp() {
  const request = getRequest();
  const origin =
    request?.headers.get("origin") ??
    (request?.headers.get("host") ? `https://${request.headers.get("host")}` : undefined);
  if (!origin) throw new Error("Unable to determine request origin");
  const rpID = new URL(origin).hostname;
  return { origin, rpID };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function sessionIdOf(claims: unknown): string {
  const sid = (claims as Record<string, unknown> | undefined)?.["session_id"];
  if (typeof sid !== "string" || !/^[0-9a-f-]{36}$/i.test(sid)) throw new Error("No session");
  return sid;
}

async function admin(): Promise<AnyDb> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** Issue a challenge bound to user + session + purpose + expiry (server-only write). */
async function issueChallenge(
  userId: string,
  sessionId: string,
  purpose: string,
  challenge: string,
) {
  const db = await admin();
  const { error } = await db.from("webauthn_challenges").upsert({
    user_id: userId,
    session_id: sessionId,
    challenge,
    purpose,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
  });
  if (error) throw safeDbError(error, "start passkey verification");
}

/** Single-use consume: deletes the row and returns it only if every binding matches. */
async function consumeChallenge(
  userId: string,
  sessionId: string,
  purpose: string,
): Promise<string> {
  const db = await admin();
  const { data } = await db
    .from("webauthn_challenges")
    .delete()
    .eq("user_id", userId)
    .select("challenge, purpose, session_id, expires_at")
    .maybeSingle();
  const { challengeIsValid } = await import("@/lib/passkey-policy");
  if (!data || !challengeIsValid(data, { sessionId, purpose })) {
    throw new Error("No active passkey challenge for this session");
  }
  return data.challenge as string;
}

export const startPasskeyRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Enrolment is a credential change: active (unlocked) session AND a
    // verified recent re-authentication. A locked session can never enrol.
    const { assertSessionActive, assertRecentReauth } = await import("@/lib/roles.server");
    await assertSessionActive(context);
    assertRecentReauth(context.claims as Record<string, unknown>);
    const sessionId = sessionIdOf(context.claims);
    const { rpID } = getRp();
    const { generateRegistrationOptions } = await loadWebauthn();
    const db = context.supabase as AnyDb;

    const { data: existing } = await db
      .from("webauthn_credentials")
      .select("credential_id, transports")
      .eq("user_id", context.userId);

    const options = await generateRegistrationOptions({
      rpName: "ICU Handover",
      rpID,
      userID: new TextEncoder().encode(context.userId),
      userName: (context.claims.email as string) ?? context.userId,
      attestationType: "none",
      excludeCredentials: (existing ?? []).map(
        (c: { credential_id: string; transports: string[] }) => ({
          id: c.credential_id,
          transports: c.transports as AnyDb,
        }),
      ),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });

    await issueChallenge(context.userId, sessionId, "registration", options.challenge);

    return options;
  });

export const finishPasskeyRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        response: z.any(),
        deviceLabel: z.string().trim().max(120).optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { assertSessionActive, assertRecentReauth } = await import("@/lib/roles.server");
    await assertSessionActive(context);
    assertRecentReauth(context.claims as Record<string, unknown>);
    const sessionId = sessionIdOf(context.claims);
    const { origin, rpID } = getRp();
    const { verifyRegistrationResponse, isoBase64URL } = await loadWebauthn();
    const expectedChallenge = await consumeChallenge(context.userId, sessionId, "registration");

    const verification = await verifyRegistrationResponse({
      response: data.response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error("Passkey registration could not be verified");
    }

    const { credential } = verification.registrationInfo;

    const db = await admin();
    const { error } = await db.from("webauthn_credentials").insert({
      user_id: context.userId,
      credential_id: credential.id,
      public_key: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      device_label: data.deviceLabel || null,
    });
    if (error) throw safeDbError(error, "register your passkey");

    return { ok: true };
  });

export const startPasskeyUnlock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const sessionId = sessionIdOf(context.claims);
    const { rpID } = getRp();
    const { generateAuthenticationOptions } = await loadWebauthn();
    const db = await admin();

    const { data: creds } = await db
      .from("webauthn_credentials")
      .select("credential_id, transports")
      .eq("user_id", context.userId);

    if (!creds || creds.length === 0) {
      throw new Error("No passkeys registered");
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      allowCredentials: creds.map((c: { credential_id: string; transports: string[] }) => ({
        id: c.credential_id,
        transports: c.transports as AnyDb,
      })),
    });

    await issueChallenge(context.userId, sessionId, "authentication", options.challenge);

    return options;
  });

export const finishPasskeyUnlock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ response: z.any() }).parse(input))
  .handler(async ({ context, data }) => {
    const sessionId = sessionIdOf(context.claims);
    const { origin, rpID } = getRp();
    const { verifyAuthenticationResponse, isoBase64URL } = await loadWebauthn();
    const db = await admin();
    const expectedChallenge = await consumeChallenge(context.userId, sessionId, "authentication");

    const credentialId = data.response?.id as string;
    const { data: cred } = await db
      .from("webauthn_credentials")
      .select("*")
      .eq("user_id", context.userId)
      .eq("credential_id", credentialId)
      .maybeSingle();
    if (!cred) throw new Error("Unknown passkey");

    const verification = await verifyAuthenticationResponse({
      response: data.response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: cred.credential_id,
        publicKey: isoBase64URL.toBuffer(cred.public_key),
        counter: Number(cred.counter),
        transports: cred.transports,
      },
    });

    if (!verification.verified) {
      throw new Error("Passkey verification failed");
    }

    // counter and last_used_at are system-managed columns that clients are no
    // longer permitted to update (RLS column grants restrict authenticated
    // UPDATE to device_label only). Persist the verification result with the
    // service-role client so the signature counter cannot be tampered with.
    const supabaseAdmin = db;
    await supabaseAdmin
      .from("webauthn_credentials")
      .update({
        counter: verification.authenticationInfo.newCounter,
        last_used_at: new Date().toISOString(),
      })
      .eq("id", cred.id);

    // Server-side unlock of THIS session only (session_id from the verified
    // JWT). Only the service role may call session_unlock, so a client can
    // never clear its own lock without passing the passkey check above.
    const { data: unlocked, error: unlockErr } = await supabaseAdmin.rpc("session_unlock", {
      _session_id: sessionId,
      _user_id: context.userId,
    });
    if (unlockErr || unlocked !== true) {
      throw new Error("This session has ended. Please sign in again.");
    }

    return { ok: true };
  });

export const listPasskeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = context.supabase as AnyDb;
    const { data } = await db
      .from("webauthn_credentials")
      .select("id, device_label, created_at, last_used_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });
    return (data ?? []) as {
      id: string;
      device_label: string | null;
      created_at: string;
      last_used_at: string | null;
    }[];
  });

export const deletePasskey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { assertSessionActive } = await import("@/lib/roles.server");
    await assertSessionActive(context);
    const db = context.supabase as AnyDb;
    const { error } = await db
      .from("webauthn_credentials")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw safeDbError(error, "remove your passkey");
    return { ok: true };
  });
