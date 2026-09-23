import { useMemo, useState } from "react";
import { SupplierChargesCard } from "@/components/SupplierChargesCard.tsx";
import { useConfirm } from "@/components/Confirm.tsx";
import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import {
  Plus, UserCog, Pencil, ShieldCheck, ScrollText, Search, KeyRound, Unlock,
  ChevronRight, Lock, Wheat, Save,
} from "lucide-react";
import { api, ApiError, type UserRow, type Role, type AuditRow, type PermissionMeta, type GroupMeta, type Jins, type Business } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSort } from "@/lib/useSort.ts";
import { useFormat } from "@/lib/format.tsx";
import { actionWords, fieldWords, fmtValue, plainChanges } from "@/lib/auditWords.ts";
import { useSession } from "@/lib/session.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { HindiInput } from "@/components/HindiInput.tsx";
import { SkeletonTable, SkeletonList, SkeletonForm } from "@/components/Skeletons.tsx";
import {
  Button, Card, CardHeader, Field, Input, Select, Table, Th, Td, Tr, Badge,
  Dialog, EmptyState, Alert, Switch, Checkbox, Spinner, Tabs,
} from "@/components/ui/index.tsx";
import { useLocation, useSearch } from "wouter";
import { cn, fmtDateTime, relTime } from "@/lib/utils.ts";
import { NumberFormatCard, GeminiCard } from "./SettingsExtras.tsx";
import { BackupCard } from "@/components/BackupCard.tsx";
import { AppearanceCard } from "@/components/AppearanceCard.tsx";
import { CloudCard } from "@/components/CloudCard.tsx";
import { NetworkCard } from "@/components/NetworkCard.tsx";
import { UpdateCard } from "@/components/UpdateCard.tsx";

/* ------------------------------------------------------------------- users */

function UserDialog({ open, onClose, editing, roles }: { open: boolean; onClose: () => void; editing: UserRow | null; roles: Role[] }) {
  const { t, pick } = useI18n();
  const qc = useQueryClient();
  const isNew = !editing;
  const [f, setF] = useState(() => ({
    name: editing?.name ?? "", nameHi: editing?.nameHi ?? "", phone: editing?.phone ?? "",
    pin: "", roleId: editing?.roleId ?? roles.find((r) => r.key === "operator")?.id ?? roles[0]?.id ?? "",
    active: editing?.membershipActive ?? true,
  }));
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => isNew
      ? api.post("/users", { name: f.name, nameHi: f.nameHi || undefined, phone: f.phone || undefined, pin: f.pin, roleId: f.roleId })
      : api.put(`/users/${editing!.membershipId}`, {
          name: f.name, nameHi: f.nameHi || undefined, phone: f.phone || undefined,
          roleId: f.roleId, active: f.active, ...(f.pin ? { resetPin: f.pin } : {}),
        }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["users"] }); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  return (
    <Dialog open={open} onClose={onClose}
      title={isNew ? t("users.add") : t("users.edit")}
      footer={<>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={save.isPending}
          disabled={!f.name.trim() || (isNew && f.pin.length < 4)}
          onClick={() => { setErr(null); save.mutate(); }}>{t("common.save")}</Button>
      </>}>
      <div className="space-y-4">
        {err && <Alert tone="bad">{err}</Alert>}
        <Field label={t("auth.yourName")} required>
          <Input value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("auth.yourNameHi")}>
            <HindiInput value={f.nameHi} onChange={(v) => setF((p) => ({ ...p, nameHi: v }))} />
          </Field>
          <Field label={t("auth.phone")}>
            <Input value={f.phone} mono inputMode="tel" onChange={(e) => setF((p) => ({ ...p, phone: e.target.value }))} />
          </Field>
        </div>
        <Field label={t("users.role")} required>
          <Select value={f.roleId} onChange={(e) => setF((p) => ({ ...p, roleId: e.target.value }))}>
            {roles.map((r) => <option key={r.id} value={r.id}>{pick(r.label, r.labelHi)}</option>)}
          </Select>
        </Field>
        <Field label={isNew ? t("users.setPin") : t("users.resetPin")}
          hint={isNew ? t("auth.pinHelp") : t("common.optional")} required={isNew}>
          <Input value={f.pin} type="password" inputMode="numeric" mono maxLength={6}
            autoComplete="new-password"
            onChange={(e) => setF((p) => ({ ...p, pin: e.target.value.replace(/\D/g, "").slice(0, 6) }))} />
        </Field>
        {!isNew && (
          <div className="border-t border-line pt-4">
            <Switch checked={f.active} onChange={(v) => setF((p) => ({ ...p, active: v }))} label={t("common.active")} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function UsersPage() {
  const { t, pick, lang } = useI18n();
  const qc = useQueryClient();
  const { can, me } = useSession();
  const [dialog, setDialog] = useState<{ open: boolean; editing: UserRow | null }>({ open: false, editing: null });
  const [err, setErr] = useState<string | null>(null);

  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<UserRow[]>("/users") });
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<Role[]>("/roles") });

  const unlock = useMutation({
    mutationFn: (mid: string) => api.put(`/users/${mid}`, { unlock: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
    onError: (e) => setErr(e instanceof ApiError ? e.message : null),
  });

  const rows = users.data ?? [];
  const now = Math.floor(Date.now() / 1000);
  const sort = useSort(rows, {
    name: (u) => u.name, role: (u) => u.roleLabel, phone: (u) => u.phone, active: (u) => (u.membershipActive ? 0 : 1),
  }, { storageKey: "users" });

  return (
    <>
      <PageHeader title={t("users.title")} sub={t("users.sub")}
        action={can("users.manage") && roles.data && (
          <Button variant="primary" icon={<Plus className="h-4 w-4" />}
            onClick={() => setDialog({ open: true, editing: null })}>{t("users.add")}</Button>
        )} />

      {err && <Alert tone="bad" className="mb-4">{err}</Alert>}

      <Card>
        {users.isLoading ? <SkeletonTable rows={4} /> : rows.length === 0 ? (
          <EmptyState icon={<UserCog className="h-8 w-8" />} title={t("users.title")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th {...sort.th("name")}>{t("auth.yourName")}</Th>
                <Th {...sort.th("role")}>{t("users.role")}</Th>
                <Th {...sort.th("phone")}>{t("auth.phone")}</Th>
                <Th align="center">{t("users.overrides")}</Th>
                <Th align="center" {...sort.th("active")}>{t("common.active")}</Th>
                <Th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((u) => {
                const locked = u.lockedUntil !== null && u.lockedUntil > now;
                return (
                  <Tr key={u.membershipId} className={cn(!u.membershipActive && "opacity-55")}>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand/12 text-[12px] font-semibold text-brand">
                          {u.name.slice(0, 1).toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {pick(u.name, u.nameHi)}
                            {u.userId === me?.user.id && <span className="ml-1.5 text-[11px] text-faint">({t("users.you")})</span>}
                          </p>
                          <p className="text-[11px] text-faint">{t("users.effectivePerms", { n: u.effectivePermissions.length })}</p>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={u.roleKey === "owner" ? "brand" : "neutral"}>
                        {pick(u.roleLabel, u.roleLabelHi)}
                      </Badge>
                    </Td>
                    <Td className="num text-[13px] text-muted">{u.phone}</Td>
                    <Td align="center">
                      {u.overrides.length
                        ? <Badge tone="warn">{u.overrides.length}</Badge>
                        : <span className="text-faint">—</span>}
                    </Td>
                    <Td align="center">
                      {locked ? (
                        <Badge tone="bad"><Lock className="h-2.5 w-2.5" /> {t("users.locked")}</Badge>
                      ) : u.membershipActive ? (
                        <Badge tone="ok">{t("common.active")}</Badge>
                      ) : (
                        <Badge>{t("common.inactive")}</Badge>
                      )}
                    </Td>
                    <Td>
                      <div className="flex items-center justify-end gap-0.5">
                        {locked && can("users.manage") && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" title={t("users.unlock")}
                            onClick={() => unlock.mutate(u.membershipId)}>
                            <Unlock className="h-3.5 w-3.5 text-warn" />
                          </Button>
                        )}
                        {can("users.manage") && (
                          <Button variant="ghost" size="icon" className="h-7 w-7"
                            onClick={() => setDialog({ open: true, editing: u })} aria-label={t("common.edit")}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {dialog.open && roles.data && (
        <UserDialog key={dialog.editing?.membershipId ?? "new"} open={dialog.open}
          editing={dialog.editing} roles={roles.data}
          onClose={() => setDialog({ open: false, editing: null })} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------- roles */

export function RolesPage() {
  const { t, pick } = useI18n();
  const ask = useConfirm();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<Role[]>("/roles") });
  const cat = useQuery({
    queryKey: ["permCatalogue"],
    queryFn: () => api.get<{ permissions: PermissionMeta[]; groups: GroupMeta[] }>("/users/catalogue"),
  });

  const role = roles.data?.find((r) => r.id === selected) ?? roles.data?.[0] ?? null;
  const current = draft ?? new Set(role?.permissions ?? []);
  const dirty = draft !== null && role
    ? JSON.stringify([...draft].sort()) !== JSON.stringify([...role.permissions].sort())
    : false;

  const save = useMutation({
    mutationFn: () => api.put(`/roles/${role!.id}`, { permissions: [...current] }),
    onSuccess: async () => { setDraft(null); await qc.invalidateQueries(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const toggle = (p: string) => {
    const next = new Set(current);
    if (next.has(p)) next.delete(p); else next.add(p);
    setDraft(next);
  };

  if (roles.isLoading || cat.isLoading) {
    return (<><PageHeader title={t("roles.title")} sub={t("roles.sub")} /><Card><div className="p-4"><SkeletonList rows={6} /></div></Card></>);
  }

  const isOwner = role?.key === "owner";

  return (
    <>
      <PageHeader title={t("roles.title")} sub={t("roles.sub")} />
      {err && <Alert tone="bad" className="mb-4">{err}</Alert>}

      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <Card className="h-fit">
          <CardHeader title={t("roles.title")} />
          <div className="p-1.5">
            {roles.data?.map((r) => (
              <button key={r.id} type="button"
                onClick={async () => {
                  // unsaved ticks on this role would vanish silently: ask first
                  if (draft && r.id !== selected && !(await ask({ title: t("roles.discardChanges"), confirmLabel: t("roles.discardYes"), danger: true }))) return;
                  setSelected(r.id); setDraft(null); setErr(null);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
                  role?.id === r.id ? "bg-brand/12 text-brand" : "text-muted hover:bg-raised hover:text-ink",
                )}>
                <ShieldCheck className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{pick(r.label, r.labelHi)}</span>
                  <span className="block text-[11px] text-faint">
                    {t("roles.permCount", { n: r.permissions.length, total: cat.data?.permissions.length ?? 0 })}
                    {" · "}{t("roles.userCount", { n: r.userCount })}
                  </span>
                </span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-50" />
              </button>
            ))}
          </div>
        </Card>

        {role && (
          <Card>
            <CardHeader
              title={<span className="inline-flex items-center gap-2">
                {pick(role.label, role.labelHi)}
                {role.isSystem && <Badge>{t("roles.builtIn")}</Badge>}
              </span>}
              sub={t("roles.permCount", { n: current.size, total: cat.data?.permissions.length ?? 0 })}
              action={!isOwner && (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost"
                    onClick={() => setDraft(new Set(cat.data?.permissions.map((p) => p.key)))}>
                    {t("roles.selectAll")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDraft(new Set())}>{t("roles.clearAll")}</Button>
                  <Button size="sm" variant="primary" icon={<Save className="h-3.5 w-3.5" />}
                    disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
                    {t("common.save")}
                  </Button>
                </div>
              )}
            />
            {isOwner && <Alert tone="neutral" className="m-3">{t("roles.ownerLocked")}</Alert>}
            <div className="divide-y divide-line">
              {cat.data?.groups.map((g) => {
                const perms = cat.data.permissions.filter((p) => p.group === g.key);
                if (!perms.length) return null;
                const onCount = perms.filter((p) => current.has(p.key)).length;
                return (
                  <div key={g.key} className="p-3.5">
                    <div className="mb-2.5 flex items-center justify-between gap-2">
                      <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">{pick(g.en, g.hi)}</p>
                      <span className="num text-[11px] text-faint">{onCount}/{perms.length}</span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {perms.map((p) => (
                        <Checkbox key={p.key} disabled={isOwner}
                          checked={current.has(p.key)} onChange={() => toggle(p.key)}
                          label={pick(p.en, p.hi)} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- audit */

export function AuditPage() {
  const { t, lang } = useI18n();
  const [q, setQ] = useState("");
  const [entity, setEntity] = useState("");
  const [userId, setUserId] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [raw, setRaw] = useState<string | null>(null);

  const facets = useQuery({
    queryKey: ["audit", "facets"],
    queryFn: () => api.get<{ entities: string[]; actions: string[]; users: { userId: string; userName: string; n: number }[] }>("/audit/facets"),
  });

  // "Load more" adds the older entries below the ones already shown
  const log = useInfiniteQuery({
    queryKey: ["audit", { q, entity, userId }],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => api.get<{ rows: AuditRow[]; nextCursor: number | null }>(
      `/audit?${new URLSearchParams({
        ...(q ? { q } : {}), ...(entity ? { entity } : {}),
        ...(userId ? { userId } : {}), ...(pageParam ? { before: String(pageParam) } : {}),
      })}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const logRows = log.data?.pages.flatMap((p) => p.rows) ?? [];

  const tone = (action: string) =>
    action.includes("delete") || action.includes("failed") ? "bad"
    : action.includes("create") || action.includes("signup") ? "ok"
    : action.includes("login") || action.includes("logout") || action.includes("switch") ? "neutral"
    : "warn";

  return (
    <>
      <PageHeader title={t("audit.title")} sub={t("audit.sub")} />

      <BooksCheckCard />

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            <Input value={q} onChange={(e) => { setQ(e.target.value); }}
              placeholder={t("audit.searchPlaceholder")} className="pl-8.5" />
          </div>
          <Select value={entity} className="w-auto min-w-[130px]"
            onChange={(e) => { setEntity(e.target.value); }}>
            <option value="">{t("audit.filterEntity")}: {t("common.all")}</option>
            {facets.data?.entities.map((e) => <option key={e} value={e}>{e}</option>)}
          </Select>
          <Select value={userId} className="w-auto min-w-[130px]"
            onChange={(e) => { setUserId(e.target.value); }}>
            <option value="">{t("audit.filterUser")}: {t("common.all")}</option>
            {facets.data?.users.map((u) => <option key={u.userId} value={u.userId}>{u.userName}</option>)}
          </Select>
        </div>

        {log.isLoading ? (
          <div className="p-4"><SkeletonList rows={8} /></div>
        ) : !logRows.length ? (
          <EmptyState icon={<ScrollText className="h-8 w-8" />} title={t("audit.empty")} />
        ) : (
          <div className="divide-y divide-line/70">
            {logRows.map((r) => (
              <div key={r.id}>
                <button type="button"
                  onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                  className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-raised/50">
                  <Badge tone={tone(r.action) as never} className="mt-0.5 shrink-0" title={r.action}>{actionWords(r.action, lang)}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-ink">
                      {r.entityLabel || r.entityId || r.entity}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      {r.userName ?? "—"}
                      {r.changedKeys.length > 0 && <> · {t("audit.changed")}: {r.changedKeys.filter((k) => k !== "updatedAt").map((k) => fieldWords(k, lang)).join(", ")}</>}
                    </p>
                  </div>
                  <span className="shrink-0 text-right text-[11px] text-faint">
                    <span className="block">{relTime(r.at, lang)}</span>
                    <span className="num block opacity-70">{fmtDateTime(r.at, lang)}</span>
                  </span>
                </button>

                {expanded === r.id && (r.before || r.after) && (
                  <div className="space-y-3 bg-raised/40 px-3 py-3">
                    <PlainDiff r={r} />
                    <button type="button" className="text-[11px] text-muted underline-offset-2 hover:underline" onClick={() => setRaw(raw === r.id ? null : r.id)}>
                      {raw === r.id ? t("audit.rawHide") : t("audit.raw")}
                    </button>
                  </div>
                )}
                {expanded === r.id && raw === r.id && (r.before || r.after) && (
                  <div className="grid gap-3 bg-raised/40 px-3 pb-3 sm:grid-cols-2">
                    {r.before && (
                      <div>
                        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{t("audit.before")}</p>
                        <pre className="overflow-x-auto rounded-md border border-line bg-surface p-2 text-[11px] leading-relaxed">
                          {JSON.stringify(r.before, null, 2)}
                        </pre>
                      </div>
                    )}
                    {r.after && (
                      <div>
                        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{t("audit.after")}</p>
                        <pre className="overflow-x-auto rounded-md border border-line bg-surface p-2 text-[11px] leading-relaxed">
                          {JSON.stringify(r.after, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {log.hasNextPage && (
          <div className="border-t border-line p-3">
            <Button size="sm" className="w-full justify-center" loading={log.isFetchingNextPage}
              onClick={() => void log.fetchNextPage()}>{t("audit.loadMore")}</Button>
          </div>
        )}
      </Card>

      <p className="mt-3 text-center text-[11px] text-faint">{t("audit.readOnly")}</p>
    </>
  );
}

/** One audit entry in plain words: each changed field, before → after; for a create or delete, what the record held. */
function PlainDiff({ r }: { r: AuditRow }) {
  const { t, lang } = useI18n();
  const f = useFormat();
  const rows = plainChanges(r);
  if (!rows.length) return <p className="text-[12px] text-muted">{t("audit.noChange")}</p>;
  const both = Boolean(r.before && r.after && r.changedKeys.length);
  return (
    <table className="w-full max-w-2xl text-[12px]">
      <thead>
        <tr className="text-left text-[11px] uppercase tracking-wide text-faint">
          <th className="py-1 pr-3 font-medium">{t("audit.field")}</th>
          {both ? <><th className="py-1 pr-3 font-medium">{t("audit.before")}</th><th className="py-1 font-medium">{t("audit.after")}</th></> : <th className="py-1 font-medium">{r.after ? t("audit.after") : t("audit.before")}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((x) => (
          <tr key={x.key} className="border-t border-line/60">
            <td className="py-1 pr-3 text-muted">{fieldWords(x.key, lang)}</td>
            {both ? (
              <>
                <td className="num py-1 pr-3 text-faint line-through">{fmtValue(x.key, x.before, f, lang)}</td>
                <td className="num py-1 font-medium text-ink">{fmtValue(x.key, x.after, f, lang)}</td>
              </>
            ) : <td className="num py-1 text-ink">{fmtValue(x.key, r.after ? x.after : x.before, f, lang)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** "Check the books": the independent re-working of every figure, run on the live books from here. */
function BooksCheckCard() {
  const { t, lang } = useI18n();
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["books-check"],
    queryFn: () => api.get<{ businesses: { name: string; sections: { title: string; lines: { ok: boolean | null; text: string }[] }[]; problems: number }[]; problems: number; at: number }>("/audit/books-check"),
    enabled: false, retry: false, staleTime: Infinity,
  });
  if (!can("audit.read")) return null;
  const r = q.data;
  return (
    <Card className="mb-4">
      <CardHeader title={t("books.title")} sub={t("books.sub")}
        action={<Button variant={r ? "secondary" : "primary"} size="sm" loading={q.isFetching} icon={<ShieldCheck className="h-3.5 w-3.5" />} onClick={() => { setOpen(true); void q.refetch(); }}>{t("books.run")}</Button>} />
      {q.isError && <div className="p-4"><Alert tone="bad">{q.error instanceof ApiError ? q.error.message : t("common.somethingWrong")}</Alert></div>}
      {r && open && (
        <div className="space-y-3 p-4">
          <Alert tone={r.problems ? "bad" : "ok"}>
            <span className="font-semibold">{r.problems ? t("books.problems", { n: r.problems }) : t("books.ok")}</span>
            <span className="ml-2 text-[11px] opacity-80">{t("books.at", { at: fmtDateTime(r.at, lang) })}</span>
          </Alert>
          {r.businesses.map((b) => (
            <div key={b.name} className="grid gap-3 lg:grid-cols-2">
              {b.sections.map((sec) => (
                <div key={sec.title} className="rounded-lg border border-line p-3">
                  <p className="mb-1.5 text-[12px] font-semibold text-ink">{sec.title}</p>
                  <ul className="space-y-1 text-[12px] leading-snug">
                    {sec.lines.map((l, i) => (
                      <li key={i} className={cn("flex gap-2", l.ok === false ? "text-bad" : l.ok === true ? "text-ink" : "text-muted")}>
                        <span className="shrink-0 font-mono">{l.ok === true ? "✓" : l.ok === false ? "✗" : "·"}</span>
                        <span className="num break-words">{l.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ commodities */

export function CommoditiesPage() {
  const { t, pick } = useI18n();
  const qc = useQueryClient();
  const { can } = useSession();
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ code: "", name: "", nameHi: "", crop: "paddy" });
  const [err, setErr] = useState<string | null>(null);
  // a cancelled dialog opens empty next time
  const closeAdd = () => { setAdding(false); setF({ code: "", name: "", nameHi: "", crop: "paddy" }); setErr(null); };

  const list = useQuery({ queryKey: ["jins", "all"], queryFn: () => api.get<Jins[]>("/jins?all=1") });
  const jsort = useSort(list.data ?? [], {
    code: (j) => j.code, name: (j) => pick(j.name, j.nameHi), crop: (j) => j.crop, active: (j) => (j.active ? 0 : 1),
  }, { storageKey: "jins" });

  const save = useMutation({
    mutationFn: () => api.post("/jins", f),
    onSuccess: async () => {
      setF({ code: "", name: "", nameHi: "", crop: "paddy" });
      setAdding(false);
      await qc.invalidateQueries({ queryKey: ["jins"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const toggle = useMutation({
    mutationFn: (j: Jins) => api.put(`/jins/${j.id}`, { active: !j.active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jins"] }),
  });

  return (
    <>
      <PageHeader title={t("jins.title")} sub={t("jins.sub")}
        action={can("jins.write") && (
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            {t("jins.add")}
          </Button>
        )} />

      <Card>
        {list.isLoading ? <SkeletonTable rows={6} cols={[{ w: "w-20" }, { w: "w-40" }, { w: "w-32" }, { w: "w-20" }]} /> : (
          <Table>
            <thead>
              <tr>
                <Th className="w-24" {...jsort.th("code")}>{t("jins.code")}</Th>
                <Th {...jsort.th("name")}>{t("jins.name")}</Th>
                <Th {...jsort.th("crop")}>{t("jins.crop")}</Th>
                <Th align="center" className="w-24" {...jsort.th("active")}>{t("common.active")}</Th>
              </tr>
            </thead>
            <tbody>
              {jsort.sorted.map((j) => (
                <Tr key={j.id} className={cn(!j.active && "opacity-55")}>
                  <Td><Badge tone="brand" className="num">{j.code}</Badge></Td>
                  <Td><span className="font-medium">{pick(j.name, j.nameHi)}</span></Td>
                  <Td className="text-muted">{t(`jins.crop.${j.crop}` as never)}</Td>
                  <Td align="center">
                    {can("jins.write")
                      ? <Switch checked={j.active} onChange={() => toggle.mutate(j)} />
                      : <Badge tone={j.active ? "ok" : "neutral"}>{j.active ? t("common.active") : t("common.inactive")}</Badge>}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Dialog open={adding} onClose={closeAdd} title={t("jins.add")}
        footer={<>
          <Button onClick={closeAdd}>{t("common.cancel")}</Button>
          <Button variant="primary" loading={save.isPending}
            disabled={!f.code.trim() || !f.name.trim()}
            onClick={() => { setErr(null); save.mutate(); }}>{t("common.save")}</Button>
        </>}>
        <div className="space-y-4">
          {err && <Alert tone="bad">{err}</Alert>}
          <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
            <Field label={t("jins.code")} required>
              <Input value={f.code} mono className="uppercase"
                onChange={(e) => setF((p) => ({ ...p, code: e.target.value.toUpperCase() }))} />
            </Field>
            <Field label={t("jins.name")} required>
              <Input value={f.name} autoFocus onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} />
            </Field>
          </div>
          <Field label={`${t("jins.name")} (${t("common.hindi")})`}>
            <HindiInput value={f.nameHi} onChange={(v) => setF((p) => ({ ...p, nameHi: v }))} />
          </Field>
          <Field label={t("jins.crop")} required>
            <Select value={f.crop} onChange={(e) => setF((p) => ({ ...p, crop: e.target.value }))}>
              <option value="paddy">{t("jins.crop.paddy")}</option>
              <option value="wheat">{t("jins.crop.wheat")}</option>
              <option value="maize">{t("jins.crop.maize")}</option>
              <option value="other">{t("jins.crop.other")}</option>
            </Select>
          </Field>
        </div>
      </Dialog>
    </>
  );
}

/* ---------------------------------------------------------------- settings */

const SETTINGS_TABS = ["business", "money", "scan", "data", "me"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];

export function SettingsPage() {
  const { t, lang, setLang } = useI18n();
  // the tab is in the address (/settings?tab=scan), so a link can open the right one
  const search = useSearch();
  const [, navigate] = useLocation();
  const asked = new URLSearchParams(search).get("tab") as SettingsTab | null;
  const tab: SettingsTab = asked && SETTINGS_TABS.includes(asked) ? asked : "business";
  const pickTab = (v: SettingsTab) => navigate(`/settings?tab=${v}`, { replace: true });
  const qc = useQueryClient();
  const { can, refresh } = useSession();
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const biz = useQuery({ queryKey: ["business"], queryFn: () => api.get<Business>("/business/current") });
  const [f, setF] = useState<Partial<Business>>({});

  const v = (k: keyof Business) => (f[k] ?? biz.data?.[k] ?? "") as string;
  // editing again means the last "Saved" no longer describes what is on screen
  const set = (k: keyof Business) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setOk(false);
    setF((p) => ({ ...p, [k]: e.target.value }));
  };

  const save = useMutation({
    mutationFn: () => api.put("/business/current", { ...f, setupComplete: true }),
    onSuccess: async () => {
      setOk(true); setF({});
      await qc.invalidateQueries({ queryKey: ["business"] });
      await refresh();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const [pin, setPin] = useState({ currentPin: "", newPin: "", again: "" });
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const changePin = useMutation({
    mutationFn: () => api.post("/auth/change-pin", { currentPin: pin.currentPin, newPin: pin.newPin }),
    onSuccess: () => { setPin({ currentPin: "", newPin: "", again: "" }); setPinMsg(t("common.saved")); },
    onError: (e) => setPinMsg(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  return (
    <>
      <PageHeader title={t("nav.settings")} sub={t("set.sub")} />
      <Tabs className="mb-4 overflow-x-auto overflow-y-hidden" value={tab} onChange={pickTab} tabs={[
        { value: "business", label: t("set.tab.business") },
        { value: "money", label: t("set.tab.money") },
        { value: "scan", label: t("set.tab.scan") },
        { value: "data", label: t("set.tab.data") },
        { value: "me", label: t("set.tab.me") },
      ]} />

      {tab === "business" && (
        <div className="max-w-3xl">
        <Card>
            <CardHeader title={t("biz.profile")} sub={t("biz.current")} />
            {biz.isLoading ? <div className="p-4"><SkeletonForm fields={7} /></div> : (
              <div className="space-y-4 p-4">
                {err && <Alert tone="bad">{err}</Alert>}
                {ok && <Alert tone="ok">{t("common.saved")}</Alert>}
                <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
                  <Field label={t("auth.businessName")}><Input value={v("name")} onChange={set("name")} disabled={!can("business.write")} /></Field>
                  <Field label={t("auth.shortCode")}>
                    <Input value={v("shortCode")} mono className="uppercase" disabled={!can("business.write")}
                      onChange={(e) => setF((p) => ({ ...p, shortCode: e.target.value.toUpperCase() }))} />
                  </Field>
                </div>
                <Field label={t("auth.businessNameHi")}><HindiInput value={v("nameHi")} onChange={(x) => setF((p) => ({ ...p, nameHi: x }))} disabled={!can("business.write")} /></Field>
                <Field label={t("biz.addressLine1")}><Input value={v("addressLine1")} onChange={set("addressLine1")} disabled={!can("business.write")} /></Field>
                <Field label={t("biz.addressLine2")}><Input value={v("addressLine2")} onChange={set("addressLine2")} disabled={!can("business.write")} /></Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("biz.city")}><Input value={v("city")} onChange={set("city")} disabled={!can("business.write")} /></Field>
                  <Field label={t("biz.district")}><Input value={v("district")} onChange={set("district")} disabled={!can("business.write")} /></Field>
                  <Field label={t("biz.state")}><Input value={v("state")} onChange={set("state")} disabled={!can("business.write")} /></Field>
                  <Field label={t("biz.pincode")}><Input value={v("pincode")} mono onChange={set("pincode")} disabled={!can("business.write")} /></Field>
                  <Field label={t("biz.gstin")}><Input value={v("gstin")} mono className="uppercase" onChange={set("gstin")} disabled={!can("business.write")} /></Field>
                  <Field label={t("biz.panNo")}><Input value={v("panNo")} mono className="uppercase" onChange={set("panNo")} disabled={!can("business.write")} /></Field>
                  <Field label={t("biz.mandiLicense")}><Input value={v("mandiLicense")} mono onChange={set("mandiLicense")} disabled={!can("business.write")} /></Field>
                  <Field label={t("auth.phone")}><Input value={v("phone")} mono onChange={set("phone")} disabled={!can("business.write")} /></Field>
                </div>
                {can("business.write") && (
                  <Button variant="primary" loading={save.isPending}
                    disabled={Object.keys(f).length === 0}
                    onClick={() => { setErr(null); setOk(false); save.mutate(); }}>{t("common.save")}</Button>
                )}
              </div>
            )}
          </Card>
        </div>
      )}
      {tab === "money" && (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <SupplierChargesCard />
          <NumberFormatCard />
        </div>
      )}
      {tab === "scan" && <div className="max-w-3xl"><GeminiCard /></div>}
      {tab === "data" && (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <BackupCard />
          <div className="space-y-4">
            <CloudCard />
            <NetworkCard />
            <UpdateCard />
          </div>
        </div>
      )}
      {tab === "me" && (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <AppearanceCard />
          <div className="space-y-4">
          <Card>
              <CardHeader title={t("common.language")} />
              <div className="flex gap-2 p-4">
                {(["en", "hi"] as const).map((l) => (
                  <Button key={l} variant={lang === l ? "primary" : "secondary"} onClick={() => setLang(l)}>
                    {l === "en" ? "English" : "हिन्दी"}
                  </Button>
                ))}
              </div>
            </Card>

            <Card>
              <CardHeader title={t("auth.changePin")} />
              <div className="space-y-3.5 p-4">
                {pinMsg && <Alert tone={pinMsg === t("common.saved") ? "ok" : "bad"}>{pinMsg}</Alert>}
                <Field label={t("auth.currentPin")}>
                  <Input value={pin.currentPin} type="password" mono inputMode="numeric" maxLength={6}
                    onChange={(e) => setPin((p) => ({ ...p, currentPin: e.target.value.replace(/\D/g, "") }))} />
                </Field>
                <Field label={t("auth.newPin")} hint={t("auth.pinHelp")}>
                  <Input value={pin.newPin} type="password" mono inputMode="numeric" maxLength={6}
                    onChange={(e) => setPin((p) => ({ ...p, newPin: e.target.value.replace(/\D/g, "") }))} />
                </Field>
                <Field label={t("auth.pinAgain")}
                  error={pin.again && pin.again !== pin.newPin ? t("auth.pinMismatch") : undefined}>
                  <Input value={pin.again} type="password" mono inputMode="numeric" maxLength={6}
                    onChange={(e) => setPin((p) => ({ ...p, again: e.target.value.replace(/\D/g, "") }))} />
                </Field>
                <Button variant="primary" icon={<KeyRound className="h-4 w-4" />} loading={changePin.isPending}
                  disabled={pin.newPin.length < 4 || pin.newPin !== pin.again || !pin.currentPin}
                  onClick={() => { setPinMsg(null); changePin.mutate(); }}>
                  {t("auth.changePin")}
                </Button>
              </div>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
