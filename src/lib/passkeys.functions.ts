import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeDbError } from "@/lib/db-error";

// Derive the Relying Party origin + ID from the incoming request. WebAuthn
// binds credentials to the exact host, so this must reflect the live domain.
function getRp() {
  const request = getRequest();
  const origin =
    request?.headers.get("origin") ??
    (request?.headers.get("host")
      ? `https://${request.headers.get("host")}`
      : undefined);
  if (!origin) throw new Error("Unable to determine request origin");
  const rpID = new URL(origin).hostname;
  return { origin, rpID };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export const startPasskeyRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { rpID } = getRp();
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

    await db.from("webauthn_challenges").upsert({
      user_id: context.userId,
      challenge: options.challenge,
      purpose: "registration",
    });

    return options;
  });

export const finishPasskeyRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response: z.any(),
        deviceLabel: z.string().trim().max(120).optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { origin, rpID } = getRp();
    const db = context.supabase as AnyDb;

    const { data: ch } = await db
      .from("webauthn_challenges")
      .select("challenge, purpose")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!ch || ch.purpose !== "registration") {
      throw new Error("No active registration challenge");
    }

    const verification = await verifyRegistrationResponse({
      response: data.response,
      expectedChallenge: ch.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error("Passkey registration could not be verified");
    }

    const { credential } = verification.registrationInfo;

    const { error } = await db.from("webauthn_credentials").insert({
      user_id: context.userId,
      credential_id: credential.id,
      public_key: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      device_label: data.deviceLabel || null,
    });
    if (error) throw new Error(error.message);

    await db.from("webauthn_challenges").delete().eq("user_id", context.userId);

    return { ok: true };
  });

export const startPasskeyUnlock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { rpID } = getRp();
    const db = context.supabase as AnyDb;

    const { data: creds } = await db
      .from("webauthn_credentials")
      .select("credential_id, transports")
      .eq("user_id", context.userId);

    if (!creds || creds.length === 0) {
      throw new Error("No passkeys registered");
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "preferred",
      allowCredentials: creds.map(
        (c: { credential_id: string; transports: string[] }) => ({
          id: c.credential_id,
          transports: c.transports as AnyDb,
        }),
      ),
    });

    await db.from("webauthn_challenges").upsert({
      user_id: context.userId,
      challenge: options.challenge,
      purpose: "authentication",
    });

    return options;
  });

export const finishPasskeyUnlock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    z.object({ response: z.any() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { origin, rpID } = getRp();
    const db = context.supabase as AnyDb;

    const { data: ch } = await db
      .from("webauthn_challenges")
      .select("challenge, purpose")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!ch || ch.purpose !== "authentication") {
      throw new Error("No active unlock challenge");
    }

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
      expectedChallenge: ch.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
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

    await db
      .from("webauthn_credentials")
      .update({
        counter: verification.authenticationInfo.newCounter,
        last_used_at: new Date().toISOString(),
      })
      .eq("id", cred.id);

    await db.from("webauthn_challenges").delete().eq("user_id", context.userId);

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
    const db = context.supabase as AnyDb;
    const { error } = await db
      .from("webauthn_credentials")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
