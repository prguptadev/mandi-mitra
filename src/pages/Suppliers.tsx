import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Users2, Sparkles, Lock, Unlock, Trash2, Pencil, Tag, RefreshCw } from "lucide-react";
import { api, ApiError, type Adati, type AdatiAlias } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { SkeletonTable } from "@/components/Skeletons.tsx";
import {
  Button, Card, Field, Input, Textarea, Table, Th, Td, Tr, Badge, Dialog,
  EmptyState, Alert, Switch, Checkbox, Spinner,
} from "@/components/ui/index.tsx";
import { cn, fmtINR, relTime } from "@/lib/utils.ts";

/** Debounced server-side transliteration preview while the Hindi name is typed. */
function useHinglishPreview(nameHi: string, enabled: boolean) {
  const [value, setValue] = useState("");
  const q = useQuery({
    queryKey: ["translit", nameHi],
    queryFn: () => api.post<{ hinglish: string }>("/auth/transliterate", { text: nameHi }),
    enabled: enabled && nameHi.trim().length > 0,
    staleTime: Infinity,
  });
  const next = q.data?.hinglish ?? "";
  if (next !== value) setValue(next);
  return { hinglish: value, loading: q.isFetching };
}

function SupplierDialog({
  open, onClose, editing,
}: { open: boolean; onClose: () => void; editing: Adati | null }) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const isNew = !editing;

  const [f, setF] = useState(() => ({
    nameHi: editing?.nameHi ?? "",
    nameHinglish: editing?.nameHinglish ?? "",
    locked: editing?.nameHinglishLocked ?? false,
    village: editing?.village ?? "",
    villageHi: editing?.villageHi ?? "",
    phone: editing?.phone ?? "",
    accountNo: editing?.accountNo ?? "",
    ifsc: editing?.ifsc ?? "",
    openingBalance: editing ? String(editing.openingBalancePaise / 100) : "",
    notes: editing?.notes ?? "",
    active: editing?.active ?? true,
  }));
  const [err, setErr] = useState<string | null>(null);

  const auto = useHinglishPreview(f.nameHi, !f.locked);
  const shownHinglish = f.locked ? f.nameHinglish : auto.hinglish;

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        nameHi: f.nameHi,
        nameHinglish: f.locked ? f.nameHinglish : undefined,
        nameHinglishLocked: f.locked,
        village: f.village || undefined,
        villageHi: f.villageHi || undefined,
        phone: f.phone || undefined,
        accountNo: f.accountNo || undefined,
        ifsc: f.ifsc || undefined,
        openingBalanceRupees: f.openingBalance ? Number(f.openingBalance) : undefined,
        notes: f.notes || undefined,
        active: f.active,
      };
      return isNew ? api.post("/adati", payload) : api.put(`/adati/${editing!.id}`, payload);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["adati"] });
      onClose();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  return (
    <Dialog
      open={open} onClose={onClose} wide
      title={isNew ? t("adati.add") : t("adati.edit")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" loading={save.isPending}
            disabled={!f.nameHi.trim()} onClick={() => { setErr(null); save.mutate(); }}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {err && <Alert tone="bad">{err}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("adati.nameHi")} hint={t("adati.nameHiHelp")} required>
            <Input
              value={f.nameHi} onChange={(e) => setF((p) => ({ ...p, nameHi: e.target.value }))}
              lang="hi" autoFocus placeholder="फूलसिंह वर्मा" className="text-[15px]"
            />
          </Field>

          <Field
            label={t("adati.nameHinglish")}
            hint={f.locked ? undefined : t("adati.nameHinglishHelp")}
            suffix={
              f.locked
                ? <button type="button"
                    onClick={() => setF((p) => ({ ...p, locked: false }))}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:underline">
                    <RefreshCw className="h-3 w-3" /> {t("adati.resetAuto")}
                  </button>
                : <Badge tone="brand"><Sparkles className="h-2.5 w-2.5" /> {t("adati.autoFilled")}</Badge>
            }
          >
            <div className="relative">
              <Input
                value={shownHinglish}
                onChange={(e) => setF((p) => ({ ...p, nameHinglish: e.target.value, locked: true }))}
                placeholder="Phoolsingh Verma" className="text-[15px] pr-8"
              />
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2">
                {auto.loading && !f.locked
                  ? <Spinner className="h-3.5 w-3.5" />
                  : f.locked
                    ? <span title={t("adati.edited")}><Lock className="h-3.5 w-3.5 text-warn" /></span>
                    : <Unlock className="h-3.5 w-3.5 text-faint" />}
              </span>
            </div>
          </Field>
        </div>

        {!f.locked && f.nameHi.trim() && (
          <p className="-mt-1 text-xs text-faint">
            {t("adati.nameHinglishHelp")}
          </p>
        )}

        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <Field label={t("adati.village")}>
            <Input value={f.village} onChange={(e) => setF((p) => ({ ...p, village: e.target.value }))} />
          </Field>
          <Field label={`${t("adati.village")} (${t("common.hindi")})`}>
            <Input value={f.villageHi} onChange={(e) => setF((p) => ({ ...p, villageHi: e.target.value }))} lang="hi" />
          </Field>
          <Field label={t("adati.phone")}>
            <Input value={f.phone} onChange={(e) => setF((p) => ({ ...p, phone: e.target.value }))} inputMode="tel" mono />
          </Field>
          <Field label={t("adati.openingBalance")} hint={t("common.rupees")}>
            <Input value={f.openingBalance} onChange={(e) => setF((p) => ({ ...p, openingBalance: e.target.value }))}
              inputMode="decimal" mono placeholder="0.00" />
          </Field>
          <Field label={t("adati.accountNo")}>
            <Input value={f.accountNo} onChange={(e) => setF((p) => ({ ...p, accountNo: e.target.value }))} mono />
          </Field>
          <Field label={t("adati.ifsc")}>
            <Input value={f.ifsc} onChange={(e) => setF((p) => ({ ...p, ifsc: e.target.value.toUpperCase() }))} mono className="uppercase" />
          </Field>
        </div>

        <Field label={t("adati.notes")}>
          <Textarea value={f.notes} onChange={(e) => setF((p) => ({ ...p, notes: e.target.value }))} lang={lang} />
        </Field>

        <div className="border-t border-line pt-4">
          <Switch checked={f.active} onChange={(v) => setF((p) => ({ ...p, active: v }))} label={t("common.active")} />
        </div>

        {!isNew && <AliasPanel adatiId={editing!.id} />}
      </div>
    </Dialog>
  );
}

/** The OCR memory for one supplier. */
function AliasPanel({ adatiId }: { adatiId: string }) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const { can } = useSession();
  const [draft, setDraft] = useState("");

  const q = useQuery({
    queryKey: ["adati", adatiId],
    queryFn: () => api.get<Adati & { aliases: AdatiAlias[] }>(`/adati/${adatiId}`),
  });

  const add = useMutation({
    mutationFn: () => api.post("/adati/learn", { adatiId, rawText: draft.trim(), source: "manual" }),
    onSuccess: async () => { setDraft(""); await qc.invalidateQueries({ queryKey: ["adati"] }); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/adati/alias/${id}`),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["adati"] }); },
  });

  const sourceLabel = (s: string) =>
    s === "canonical" ? t("adati.aliasSourceCanonical")
    : s === "rename" ? t("adati.aliasSourceRename")
    : s === "ocr" ? t("adati.aliasSourceOcr")
    : t("adati.aliasSourceCorrection");

  return (
    <div className="rounded-lg border border-line bg-raised/40 p-3.5">
      <div className="mb-1 flex items-center gap-2">
        <Tag className="h-3.5 w-3.5 text-brand" />
        <p className="text-[13px] font-semibold text-ink">{t("adati.aliases")}</p>
        {q.data && <Badge>{q.data.aliases.length}</Badge>}
      </div>
      <p className="mb-3 text-xs leading-relaxed text-muted">{t("adati.aliasHelp")}</p>

      {q.isLoading ? (
        <Spinner />
      ) : (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {q.data?.aliases.map((a) => (
            <span key={a.id}
              className="group inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-[13px]">
              <span lang="hi" className="text-ink">{a.rawText}</span>
              <span className="num text-[10px] text-faint" title={`${a.hits} ${t("adati.aliasHits")}`}>{a.hits}x</span>
              <span className="text-[10px] text-faint">{sourceLabel(a.source)}</span>
              {can("adati.write") && a.source !== "canonical" && (
                <button type="button" onClick={() => del.mutate(a.id)}
                  className="opacity-0 transition-opacity group-hover:opacity-100" aria-label={t("common.delete")}>
                  <Trash2 className="h-3 w-3 text-bad" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {can("adati.write") && (
        <div className="flex gap-2">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} lang="hi"
            placeholder={t("adati.aliasAdd")} className="h-8 text-[13px]"
            onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { e.preventDefault(); add.mutate(); } }} />
          <Button size="sm" onClick={() => add.mutate()} disabled={!draft.trim()} loading={add.isPending}>
            {t("common.add")}
          </Button>
        </div>
      )}
    </div>
  );
}

export function SuppliersPage() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const { can } = useSession();
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [dialog, setDialog] = useState<{ open: boolean; editing: Adati | null }>({ open: false, editing: null });
  const [notice, setNotice] = useState<string | null>(null);
  /** Which spelling the table and CSV use. */
  const [nameMode, setNameMode] = useState<"hi" | "hinglish" | "both">("both");

  const list = useQuery({
    queryKey: ["adati", { q, showInactive }],
    queryFn: () => api.get<Adati[]>(`/adati?${new URLSearchParams({ ...(q ? { q } : {}), ...(showInactive ? { all: "1" } : {}) })}`),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.del<{ deactivated: boolean; reason?: string }>(`/adati/${id}`),
    onSuccess: async (r) => {
      setNotice(r.deactivated ? t("adati.deactivated") : t("common.deleted"));
      await qc.invalidateQueries({ queryKey: ["adati"] });
    },
  });

  const regen = useMutation({
    mutationFn: () => api.post<{ scanned: number; changed: number }>("/adati/regenerate-hinglish"),
    onSuccess: async (r) => {
      setNotice(t("adati.regenerateDone", { n: r.changed, total: r.scanned }));
      await qc.invalidateQueries({ queryKey: ["adati"] });
    },
  });

  const rows = list.data ?? [];

  const csv = useMemo(() => {
    const header = ["Sr", ...(nameMode === "hi" ? ["Name (Hindi)"] : nameMode === "hinglish" ? ["Name"] : ["Name (Hindi)", "Name (Hinglish)"]),
      "Village", "Phone", "Account No", "IFSC", "Opening Balance", "Status"];
    const lines = rows.map((r, i) => [
      i + 1,
      ...(nameMode === "hi" ? [r.nameHi] : nameMode === "hinglish" ? [r.nameHinglish] : [r.nameHi, r.nameHinglish]),
      r.village ?? "", r.phone ?? "", r.accountNo ?? "", r.ifsc ?? "",
      (r.openingBalancePaise / 100).toFixed(2), r.active ? "Active" : "Inactive",
    ]);
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    return [header, ...lines].map((r) => r.map(esc).join(",")).join("\r\n");
  }, [rows, nameMode]);

  const download = () => {
    // BOM so Excel on Windows opens Devanagari correctly instead of mojibake
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `suppliers-${nameMode}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <PageHeader
        title={t("adati.title")} sub={t("adati.sub")}
        action={can("adati.write") && (
          <Button variant="primary" icon={<Plus className="h-4 w-4" />}
            onClick={() => setDialog({ open: true, editing: null })}>
            {t("adati.add")}
          </Button>
        )}
      />

      {notice && <Alert tone="ok" className="mb-4">{notice}</Alert>}

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            <Input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={t("adati.searchPlaceholder")} className="pl-8.5" />
          </div>

          {/* the Hindi / Hinglish toggle, applied to the table and the CSV */}
          <div className="flex items-center rounded-lg border border-line bg-raised/60 p-0.5">
            {([["hi", t("common.hindi")], ["hinglish", t("common.hinglish")], ["both", t("common.all")]] as const).map(([v, label]) => (
              <button key={v} type="button" onClick={() => setNameMode(v)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                  nameMode === v ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink",
                )}>
                {label}
              </button>
            ))}
          </div>

          <Checkbox checked={showInactive} onChange={setShowInactive} label={t("common.showInactive")} />

          {can("export.data") && (
            <Button size="sm" onClick={download} disabled={!rows.length}>CSV</Button>
          )}
          {can("adati.write") && (
            <Button size="sm" variant="ghost" loading={regen.isPending}
              icon={<Sparkles className="h-3.5 w-3.5" />} onClick={() => regen.mutate()}
              title={t("adati.regenerate")}>
              <span className="hidden sm:inline">{t("adati.regenerate")}</span>
            </Button>
          )}
        </div>

        {list.isLoading ? (
          <SkeletonTable rows={8} cols={[{ w: "w-44" }, { w: "w-40" }, { w: "w-24" }, { w: "w-24" }, { w: "w-20", numeric: true }, { w: "w-16" }]} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Users2 className="h-8 w-8" />}
            title={q ? t("common.noResults") : t("adati.empty")}
            sub={q ? undefined : t("adati.emptySub")}
            action={!q && can("adati.write") && (
              <Button variant="primary" icon={<Plus className="h-4 w-4" />}
                onClick={() => setDialog({ open: true, editing: null })}>{t("adati.add")}</Button>
            )}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-10">#</Th>
                {nameMode !== "hinglish" && <Th>{t("adati.nameHi")}</Th>}
                {nameMode !== "hi" && <Th>{t("adati.nameHinglish")}</Th>}
                <Th>{t("adati.village")}</Th>
                <Th>{t("adati.phone")}</Th>
                <Th numeric>{t("adati.openingBalance")}</Th>
                <Th align="center">{t("adati.aliases")}</Th>
                <Th className="w-20" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Tr key={r.id} className={cn(!r.active && "opacity-55")}>
                  <Td className="num text-[12px] text-faint">{i + 1}</Td>
                  {nameMode !== "hinglish" && (
                    <Td><span lang="hi" className="font-medium text-[15px]">{r.nameHi}</span></Td>
                  )}
                  {nameMode !== "hi" && (
                    <Td>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-medium">{r.nameHinglish}</span>
                        {!r.nameHinglishLocked
                          ? <span title={t("adati.autoFilled")}><Sparkles className="h-3 w-3 text-faint" /></span>
                          : <span title={t("adati.edited")}><Lock className="h-3 w-3 text-warn/70" /></span>}
                      </span>
                    </Td>
                  )}
                  <Td className="text-muted">{lang === "hi" ? (r.villageHi || r.village) : (r.village || r.villageHi)}</Td>
                  <Td className="num text-[13px] text-muted">{r.phone}</Td>
                  <Td numeric className={cn(r.openingBalancePaise === 0 && "text-faint")}>
                    {fmtINR(r.openingBalancePaise)}
                  </Td>
                  <Td align="center">
                    {r.aliasCount ? <Badge tone="brand">{r.aliasCount}</Badge> : <span className="text-faint">—</span>}
                  </Td>
                  <Td>
                    <div className="flex items-center justify-end gap-0.5">
                      {can("adati.write") && (
                        <Button variant="ghost" size="icon" className="h-7 w-7"
                          onClick={() => setDialog({ open: true, editing: r })} aria-label={t("common.edit")}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {can("adati.delete") && (
                        <Button variant="ghost" size="icon" className="h-7 w-7"
                          onClick={() => { if (confirm(t("common.confirmDelete"))) del.mutate(r.id); }}
                          aria-label={t("common.delete")}>
                          <Trash2 className="h-3.5 w-3.5 text-bad/80" />
                        </Button>
                      )}
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}

        {rows.length > 0 && (
          <div className="flex items-center justify-between px-3 py-2.5 text-xs text-faint">
            <span>{t("adati.count", { n: rows.length })}</span>
            <span className="num">{rows.filter((r) => !r.nameHinglishLocked).length} auto · {rows.filter((r) => r.nameHinglishLocked).length} edited</span>
          </div>
        )}
      </Card>

      {dialog.open && (
        <SupplierDialog
          key={dialog.editing?.id ?? "new"}
          open={dialog.open} editing={dialog.editing}
          onClose={() => setDialog({ open: false, editing: null })}
        />
      )}
    </>
  );
}
