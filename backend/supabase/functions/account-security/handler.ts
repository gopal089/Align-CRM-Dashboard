import { createClient } from "@supabase/supabase-js";
import {
  backupCodes,
  digest,
  normalCode,
  sessionId,
  text,
  uuid,
} from "./core.ts";
export function createSecurityHandler(env: (key: string) => string) {
  const url = env("SUPABASE_URL"),
    key = env("SUPABASE_ANON_KEY");
  const admin = createClient(url, env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const origins = new Set(
    env("SECURITY_ALLOWED_ORIGINS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  class Failure extends Error {
    constructor(
      message: string,
      public status = 400,
    ) {
      super(message);
    }
  }
  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await admin.rpc(name, args);
    if (error)
      throw new Failure(
        error.message.includes("Session expired")
          ? "Session expired. Sign in again"
          : "Security check failed. Sign in again or retry.",
        401,
      );
    return data;
  }
  async function limited(bucket: string, attempts = 10) {
    if (
      !(await rpc("security_rate_limit", { b: bucket, max_attempts: attempts }))
    )
      throw new Failure("Too many attempts. Try again in 15 minutes.", 429);
  }
  async function auth(
    path: string,
    body: unknown,
    token = key,
    method = "POST",
  ) {
    const result = await fetch(`${url}/auth/v1/${path}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await result.json().catch(() => ({}));
    if (!result.ok)
      throw new Failure(
        result.status === 429
          ? "Too many attempts. Try again later."
          : "Unable to verify these credentials or code.",
        result.status === 429 ? 429 : 400,
      );
    return data;
  }
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin") || "";
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Origin",
      "Access-Control-Allow-Origin": origins.has(origin) ? origin : "",
      "Access-Control-Allow-Headers":
        "authorization,apikey,content-type,x-client-info",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
    };
    const reply = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers });
    if (origin && !origins.has(origin))
      return reply({ error: "Origin is not allowed" }, 403);
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return reply({ error: "Use POST" }, 405);
    try {
      if (!req.body) throw new Failure("Missing request body");
      const reader = req.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16384) {
          await reader.cancel();
          throw new Failure("Request too large", 413);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const raw = new TextDecoder().decode(bytes);
      const p = JSON.parse(raw);
      const action = text(p.action, 30);
      if (action === "login_check") {
        const email = text(p.email, 254).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
          throw new Failure("Enter a valid email");
        await limited("login:" + (await digest(email)));
        return reply({ ok: true });
      }
      const jwt =
        req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
      const {
        data: { user },
        error,
      } = await admin.auth.getUser(jwt);
      if (error || !user) throw new Failure("Sign in again", 401);
      const sid = sessionId(jwt),
        u = user.id;
      const service = (action: string, payload: Record<string, unknown> = {}) =>
        rpc("security_service", { action, u, sid, payload });
      const state = await service(
        action === "register" ? "register" : "status",
      );
      if (["register", "status"].includes(action)) return reply(state);
      if (["verify", "enable", "disable", "codes", "enroll"].includes(action))
        await limited("code:" + u);
      let tokens: { access_token: string; refresh_token: string } | undefined;
      async function verify(factor: string, code: string) {
        const challenge = await auth(
          `factors/${uuid(factor)}/challenge`,
          {},
          jwt,
        );
        const result = await auth(
          `factors/${factor}/verify`,
          { challenge_id: challenge.id, code },
          jwt,
        );
        if (sessionId(result.access_token) !== sid)
          throw new Failure("Session changed. Sign in again", 401);
        tokens = {
          access_token: result.access_token,
          refresh_token: result.refresh_token,
        };
      }
      async function verifyEnabled() {
        const code = normalCode(p.code);
        if (code.length === 32) {
          const result = await service("backup", {
            hash: await digest(u + ":" + code),
          });
          if (!result.valid)
            throw new Failure("Invalid or already used backup code");
        } else {
          if (!state.enabled || !state.factor_id)
            throw new Failure("2FA is not enabled");
          await verify(state.factor_id, code);
          await service("verify", { factor_id: state.factor_id });
        }
      }
      if (action === "verify") {
        await verifyEnabled();
        return reply({ ok: true, session: tokens });
      }
      if (state.needs_code)
        throw new Failure("Two-step verification required", 403);
      if (action === "enroll") {
        if (state.enabled) throw new Failure("2FA is already enabled");
        // Clear abandoned, unverified enrollment before retrying setup.
        if (state.pending_factor_id) {
          const { error } = await admin.auth.admin.mfa.deleteFactor({
            userId: u,
            id: state.pending_factor_id,
          });
          if (error && error.status !== 404)
            throw new Failure("Unable to restart setup");
        }
        const factor = await auth(
          "factors",
          {
            factor_type: "totp",
            friendly_name: "Align authenticator",
            issuer: "Align CRM",
          },
          jwt,
        );
        await service("pending", { factor_id: factor.id });
        return reply({
          qr_code: factor.totp.qr_code,
          secret: factor.totp.secret,
        });
      }
      if (action === "enable") {
        const code = normalCode(p.code);
        if (code.length !== 6 || !state.pending_factor_id)
          throw new Failure("Start setup and enter the six-digit code");
        await verify(state.pending_factor_id, code);
        const backups = await backupCodes(u);
        await service("enable", {
          factor_id: state.pending_factor_id,
          hashes: backups.hashes,
        });
        return reply({ codes: backups.codes, session: tokens });
      }
      if (action === "disable" || action === "codes") {
        // A fresh password check is required even when the existing session has passed MFA.
        const signed = await auth("token?grant_type=password", {
          email: user.email,
          password: text(p.password, 1024),
        });
        try {
          await verifyEnabled();
        } finally {
          await auth(
            "logout?scope=local",
            undefined,
            signed.access_token,
          ).catch(() => {});
        }
        if (action === "disable") {
          const { error } = await admin.auth.admin.mfa.deleteFactor({
            userId: u,
            id: state.factor_id,
          });
          if (error && error.status !== 404)
            throw new Failure(
              "Unable to disable authenticator. Retry with a backup code.",
            );
          await service("disable", { factor_id: state.factor_id });
          return reply({ ok: true, session: tokens });
        }
        const backups = await backupCodes(u);
        await service("codes", {
          factor_id: state.factor_id,
          hashes: backups.hashes,
        });
        return reply({ codes: backups.codes, session: tokens });
      }
      if (["touch", "sessions", "revoke_others"].includes(action))
        return reply(await service(action));
      if (action === "revoke")
        return reply(await service(action, { session_id: uuid(p.session_id) }));
      throw new Failure("Unknown action");
    } catch (e) {
      return reply(
        {
          error: e instanceof Failure ? e.message : "Invalid security request",
        },
        e instanceof Failure ? e.status : 400,
      );
    }
  };
}
