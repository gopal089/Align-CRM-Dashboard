import { createContext, useContext, useEffect, useState } from "react";
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
  profiles: { name: string; email: string };
};
type Ctx = {
  session: Session | null;
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
        cache.clear();
        setOrgId("");
      }
    });
    return () => data.subscription.unsubscribe();
  }, [cache]);
  const workspace = useQuery({
    queryKey: ["workspace", session?.user.id],
    enabled: !!session,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("memberships")
        .select("*,organizations(*)")
        .eq("user_id", session!.user.id)
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
    enabled: !!org,
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
    enabled: !!session,
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
        loading: loading || workspace.isLoading,
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
