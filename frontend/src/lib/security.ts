import { supabase } from "./client";
export type SecurityState = {
  enabled: boolean;
  needs_code: boolean;
  expires_at: string;
  session_id: string;
};
export type ActiveSession = {
  id: string;
  current: boolean;
  device: string;
  ip: string | null;
  last_active: string;
  created_at: string;
};
export class SecurityError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}
export async function security<T = any>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await supabase.functions.invoke("account-security", {
    body: { action, ...payload },
  });
  if (error) {
    const details = await error.context?.json?.().catch(() => null);
    if (error.context?.status === 401)
      window.dispatchEvent(new Event("align-session-expired"));
    throw new SecurityError(
      details?.error || "Security service unavailable. Please try again.",
      error.context?.status,
    );
  }
  if (data.session) {
    const { error } = await supabase.auth.setSession(data.session);
    if (error) throw error;
  }
  return data;
}
export async function logout() {
  try {
    await security("revoke", {
      session_id: (await security<SecurityState>("status")).session_id,
    });
  } finally {
    await supabase.auth.signOut({ scope: "local" });
  }
}
