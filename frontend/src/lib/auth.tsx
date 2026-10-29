import { createContext, useContext, useEffect, useState } from "react";
import { security, SecurityError } from "./security";
import type { SecurityState } from "./security";
import type { ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { configured, supabase } from "./client";
export type Stage = {
  name: string;
  probability: number;
  outcome: "open" | "won" | "lost";
};
export type Org = {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  website: string;
  lead_sources: string[];
  pipeline_stages: Stage[];
  payment_tracking: boolean;
};
export type Member = {
  id: string;
  org_id: string;
  user_id: string;
  role: string;
  active: boolean;
  profiles: { name: string; email: string };
};
type Ctx = {
  session: Session | null;
  securityState: SecurityState | null;
  checkSecurity: () => Promise<void>;
  loading: boolean;
  error: string;
  org: Org | null;
  members: Member[];
  memberships: any[];
  role: string;
  profile: any;
  setOrgId: (id: string) => void;
  refresh: () => Promise<void>;
  recovery: boolean;
  setRecovery: (b: boolean) => void;
};
const AuthContext = createContext<Ctx>(null!);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [securityState, setSecurityState] = useState<SecurityState | null>(
    null,
  );
  const [securityLoading, setSecurityLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [orgId, setOrgId] = useState(localStorage.getItem("align-org") || "");
  const [recovery, setRecovery] = useState(
    location.pathname === "/update-password",
  );
  const cache = useQueryClient();
  useEffect(() => {
    if (!configured) {
      setLoading(false);
      return;
    }
    supabase.auth.getSession().then(({ data, error }) => {
      if (error) setError(error.message);
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      if (event === "SIGNED_OUT") {
        setRecovery(false);
        setError("");
        setSecurityState(null);
        cache.clear();
        setOrgId("");
      }
    });
    return () => data.subscription.unsubscribe();
  }, [cache]);
  const sessionKey = session?.access_token
    ? JSON.parse(
        atob(
          session.access_token
            .split(".")[1]
            .replace(/-/g, "+")
            .replace(/_/g, "/"),
        ),
      ).session_id
    : "";
  const checkSecurity = async () => {
    const state = await security<SecurityState>("register");
    setSecurityState(state);
    await cache.invalidateQueries();
  };
  useEffect(() => {
    setSecurityState(null);
    if (!sessionKey) {
      setSecurityLoading(false);
      return;
    }
    let cancelled = false;
    setSecurityLoading(true);
    security<SecurityState>("register")
      .then((state) => {
        if (!cancelled) setSecurityState(state);
      })
      .catch((e) => {
        if (!cancelled && !(e instanceof SecurityError && e.status === 401))
          setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setSecurityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);
  useEffect(() => {
    const expire = () => {
      cache.clear();
      setSession(null);
      setSecurityLoading(false);
      setSecurityState(null);
      setError("");
      void supabase.auth.signOut({ scope: "local" });
    };
    window.addEventListener("align-session-expired", expire);
    return () => window.removeEventListener("align-session-expired", expire);
  }, [cache]);
  useEffect(() => {
    if (!sessionKey || !securityState) return;
    let cancelled = false;
    let lastSent = 0,
      pending = false;
    const activity = async (event: Event) => {
      if (
        !event.isTrusted ||
        securityState.needs_code ||
        pending ||
        Date.now() - lastSent < 60_000
      )
        return;
      pending = true;
      lastSent = Date.now();
      try {
        const result = await security<{ expires_at: string }>("touch");
        setSecurityState((state) =>
          !cancelled && state && state.session_id === sessionKey
            ? { ...state, expires_at: result.expires_at }
            : state,
        );
      } catch {
        /* Server checks still deny expired sessions. */
      } finally {
        pending = false;
      }
    };
    // Polling checks revocation; it never extends the idle deadline.
    const poll = setInterval(() => {
      void security<SecurityState>("status")
        .then((state) => {
          if (cancelled) return;
          if (state.needs_code) cache.clear();
          setSecurityState(state);
        })
        .catch(() => {});
    }, 15_000);
    for (const name of ["pointerdown", "keydown", "scroll"])
      window.addEventListener(name, activity, { passive: true });
    return () => {
      cancelled = true;
      clearInterval(poll);
      for (const name of ["pointerdown", "keydown", "scroll"])
        window.removeEventListener(name, activity);
    };
  }, [sessionKey, securityState?.needs_code, cache]);
  useEffect(() => {
    if (!securityState) return;
    const deadline = new Date(securityState.expires_at).getTime();
    const expire = () =>
      window.dispatchEvent(new Event("align-session-expired"));
    const check = () => {
      if (Date.now() >= deadline) expire();
    };
    const timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
    document.addEventListener("visibilitychange", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [securityState?.expires_at]);
  const securityReady =
    !!securityState &&
    !securityState.needs_code &&
    securityState.session_id === sessionKey;
  const workspace = useQuery({
    queryKey: ["workspace", session?.user.id],
    enabled: !!session && securityReady,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("memberships")
        .select("*,organizations(*)")
        .eq("user_id", session!.user.id)
        .eq("active", true)
        .order("created_at");
      if (error) throw error;
      return data;
    },
  });
  const memberships = workspace.data || [];
  const org =
    memberships.find((m) => m.org_id === orgId)?.organizations ||
    memberships[0]?.organizations ||
    null;
  const memberQuery = useQuery({
    queryKey: ["members", org?.id],
    enabled: !!org && securityReady,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("memberships")
        .select("*,profiles(name,email)")
        .eq("org_id", org!.id)
        .order("created_at");
      if (error) throw error;
      return data as Member[];
    },
  });
  const profileQuery = useQuery({
    queryKey: ["profile", session?.user.id],
    enabled: !!session && securityReady,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", session!.user.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const refresh = async () => {
    await cache.invalidateQueries();
  };
  return (
    <AuthContext.Provider
      value={{
        session,
        securityState,
        checkSecurity,
        loading:
          loading ||
          securityLoading ||
          (!!session &&
            (!securityState || securityState.session_id !== sessionKey) &&
            !error) ||
          (securityReady && workspace.isLoading),
        error:
          error ||
          (workspace.error as Error)?.message ||
          (memberQuery.error as Error)?.message ||
          (profileQuery.error as Error)?.message ||
          "",
        org,
        members: memberQuery.data || [],
        memberships,
        role: memberships.find((m) => m.org_id === org?.id)?.role || "",
        profile: profileQuery.data,
        setOrgId: (id) => {
          localStorage.setItem("align-org", id);
          setOrgId(id);
          cache.invalidateQueries();
        },
        refresh,
        recovery,
        setRecovery,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
export const useAuth = () => useContext(AuthContext);
