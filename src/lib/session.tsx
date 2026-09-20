import { createContext, useContext, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Me } from "./api.ts";

interface Ctx {
  me: Me | null;
  loading: boolean;
  error: ApiError | null;
  can: (...perms: string[]) => boolean;
  refresh: () => Promise<void>;
  switchBusiness: (id: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionCtx = createContext<Ctx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<Me>("/auth/me"),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
    staleTime: 30_000,
  });

  const switchM = useMutation({
    mutationFn: (businessId: string) => api.post("/auth/switch-business", { businessId }),
    onSuccess: async () => { await qc.invalidateQueries(); },
  });

  const logoutM = useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSuccess: () => { qc.clear(); },
  });

  const me = q.data ?? null;
  const permSet = new Set(me?.permissions ?? []);

  const value: Ctx = {
    me,
    loading: q.isLoading,
    error: q.error instanceof ApiError && q.error.status !== 401 ? q.error : null,
    can: (...perms) => perms.some((p) => permSet.has(p)),
    refresh: async () => { await q.refetch(); },
    switchBusiness: async (id) => { await switchM.mutateAsync(id); },
    logout: async () => { await logoutM.mutateAsync(); },
  };

  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession() {
  const c = useContext(SessionCtx);
  if (!c) throw new Error("useSession outside SessionProvider");
  return c;
}

/** Wrap anything permission-gated. */
export function Can({ perm, children, fallback = null }: { perm: string | string[]; children: ReactNode; fallback?: ReactNode }) {
  const { can } = useSession();
  const list = Array.isArray(perm) ? perm : [perm];
  return <>{can(...list) ? children : fallback}</>;
}
