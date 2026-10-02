import { Fragment, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Copy, MessageCircle, PhoneCall, Plus, Trash2, Wallet } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useFormat, RupeeMark } from "@/lib/format.tsx";
import { useSession } from "@/lib/session.tsx";
import { useConfirm } from "@/components/Confirm.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { LoadError } from "@/components/LoadError.tsx";
import { NumberInput } from "@/components/NumberInput.tsx";
import { toastError } from "@/components/Toaster.tsx";
import { ReceiptDialog } from "@/pages/MillMoney.tsx";
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Spinner, Table, Td, Textarea, Th, Tr } from "@/components/ui/index.tsx";
import { cn, dmy, todayISO } from "@/lib/utils.ts";
import { followupNow } from "@/lib/asOfToday.ts";

/* Chasing the mills for money: who owes what, since when (the unpaid parchas,
   oldest first), when each last paid, and the call log — what was said, what
   was promised, when to ask again. Calls due today come first. */

interface Unpaid { loadId: string | null; parchaNo: string | null; date: string | null; truckNo: string | null; billPaise: number; duePaise: number; days: number | null }
interface FollowRow {
  id: string; code: string; name: string; nameHi: string | null; phone: string | null; contactPerson: string | null; city: string | null; active: boolean;
  balancePaise: number; duePaise: number; aheadPaise: number; buckets: number[]; oldestDays: number | null; oldestIsOpening: boolean; unpaid: Unpaid[];
  lastReceipt: { date: string; amountPaise: number; days: number } | null;
  followup: { id: string; note: string | null; promisedPaise: number | null; nextDate: string | null; at: number; by: string | null; count: number } | null;
  dueToday: boolean;
}
interface FollowResp { asOf: string; buckets: number[]; rows: FollowRow[]; totals: { toReceivePaise: number; buckets: number[]; mills: number; dueToday: number } }
interface Note { id: string; note: string | null; promisedPaise: number | null; nextDate: string | null; createdAt: number; byName: string | null }

const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); };
const ageTone = (d: number | null) => (d === null ? "bad" : d > 30 ? "bad" : d > 15 ? "warn" : "ok") as "bad" | "warn" | "ok";

export function MillFollowupPage() {
  const { t, pick } = useI18n();
  const f = useFormat();
  const { can } = useSession();
  // what each mill owes today: a post-dated cheque is not received before its day
  const q = useQuery({ queryKey: ["mill-followup", todayISO()], queryFn: () => api.get<FollowResp>(followupNow()) });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [noting, setNoting] = useState<FollowRow | null>(null);
  const [receiving, setReceiving] = useState<string | null>(null);
  const [messaging, setMessaging] = useState<FollowRow | null>(null);
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const d = q.data;
  const bucketLabels = [t("fu.b0"), t("fu.b1"), t("fu.b2"), t("fu.b3")];
  const today = todayISO();

  return (
    <div>
      <PageHeader title={t("fu.title")} sub={t("fu.sub")} />
      {noting && <NoteDialog mill={noting} onClose={() => setNoting(null)} />}
      {messaging && <MessageDialog mill={messaging} onClose={() => setMessaging(null)} />}
      {receiving && <ReceiptDialog merchantId={receiving} onClose={() => setReceiving(null)} />}

      {q.isError ? <LoadError error={q.error} onRetry={() => q.refetch()} /> : !d ? (
        <div className="flex justify-center p-10"><Spinner /></div>
      ) : (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label={t("fu.toReceive")} value={f.money(d.totals.toReceivePaise)} sub={t("fu.fromMills", { n: d.totals.mills })} tone="brand" />
            <Stat label={t("fu.dueToday")} value={String(d.totals.dueToday)} sub={t("fu.dueTodaySub")} tone={d.totals.dueToday ? "warn" : "ok"} />
            <Stat label={t("fu.over30")} value={f.money(d.totals.buckets[2] + d.totals.buckets[3])} sub={t("fu.over30Sub")} tone={d.totals.buckets[2] + d.totals.buckets[3] ? "bad" : "ok"} />
            <Card>
              <div className="p-4">
                <p className="text-[12px] font-medium uppercase tracking-wide text-muted">{t("fu.byAge")}</p>
                <AgeBar buckets={d.totals.buckets} labels={bucketLabels} className="mt-2" />
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                  {d.totals.buckets.map((b, i) => (
                    <span key={i} className="flex justify-between gap-2"><span className="text-muted">{bucketLabels[i]}</span><span className="num text-ink">{f.money(b, { decimals: 0 })}</span></span>
                  ))}
                </div>
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader title={t("fu.listTitle")} sub={t("fu.listSub")} />
            {!d.rows.length ? <EmptyState icon={<PhoneCall className="h-8 w-8" />} title={t("fu.none")} /> : (
              <Table>
                <thead>
                  <tr>
                    <Th />
                    <Th>{t("fu.mill")}</Th>
                    <Th numeric>{t("fu.owes")}<RupeeMark /></Th>
                    <Th>{t("fu.oldest")}</Th>
                    <Th>{t("fu.byAge")}</Th>
                    <Th>{t("fu.lastMoney")}</Th>
                    <Th>{t("fu.nextCall")}</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((m) => {
                    const isOpen = open.has(m.id);
                    return (
                      <Fragment key={m.id}>
                        <Tr className={cn(m.dueToday && m.balancePaise > 0 && "bg-warn-soft/60")}>
                          <Td className="w-8">
                            {m.unpaid.length > 0 && (
                              <button type="button" onClick={() => toggle(m.id)} aria-label={t("fu.showParchas")} className="text-faint hover:text-ink">
                                {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                              </button>
                            )}
                          </Td>
                          <Td className="min-w-[150px]">
                            <Link href={`/mill-accounts/${m.id}`} className="font-medium text-ink hover:text-brand hover:underline">{m.code} — {pick(m.name, m.nameHi)}</Link>
                            {(m.contactPerson || m.phone) && (
                              <p className="text-[11px] text-muted">{[m.contactPerson, m.phone].filter(Boolean).join(" · ")}</p>
                            )}
                          </Td>
                          <Td numeric>
                            <span className={cn("font-semibold", m.balancePaise > 0 ? "text-ink" : "text-ok")}>{f.amount(m.balancePaise)}</span>
                            {m.aheadPaise > 0 && m.balancePaise <= 0 && <p className="text-[11px] text-ok">{t("fu.paidAhead")}</p>}
                          </Td>
                          <Td>
                            {m.duePaise > 0 ? (
                              <Badge tone={ageTone(m.oldestDays)}>{m.oldestIsOpening ? t("fu.opening") : t("fu.days", { n: m.oldestDays ?? 0 })}</Badge>
                            ) : <span className="text-faint">—</span>}
                          </Td>
                          <Td className="min-w-[120px]">{m.duePaise > 0 ? <AgeBar buckets={m.buckets} labels={bucketLabels} /> : <span className="text-faint">—</span>}</Td>
                          <Td className="text-[12px]">
                            {m.lastReceipt ? (
                              <>
                                <span className="num whitespace-nowrap text-ink">{f.money(m.lastReceipt.amountPaise)}</span>
                                <p className="text-muted"><span className="whitespace-nowrap">{dmy(m.lastReceipt.date)}</span>{m.lastReceipt.days > 0 ? ` · ${t("fu.daysAgo", { n: m.lastReceipt.days })}` : ""}</p>
                              </>
                            ) : <span className="text-faint">{t("fu.never")}</span>}
                          </Td>
                          <Td className="min-w-[140px] max-w-[260px] text-[12px]">
                            {m.followup ? (
                              <>
                                {m.followup.nextDate && (
                                  <Badge tone={m.followup.nextDate < today ? "bad" : m.followup.nextDate === today ? "warn" : "neutral"}>
                                    {m.followup.nextDate <= today ? t("fu.callNow") : dmy(m.followup.nextDate)}
                                  </Badge>
                                )}
                                {m.followup.promisedPaise ? <span className="ml-1 text-muted">{t("fu.promised", { a: f.money(m.followup.promisedPaise) })}</span> : null}
                                {m.followup.note && <p className="mt-0.5 break-words text-muted" title={m.followup.note}>{m.followup.note}</p>}
                              </>
                            ) : <span className="text-faint">{t("fu.noCall")}</span>}
                          </Td>
                          <Td align="right">
                            <div className="flex flex-wrap justify-end gap-1">
                              {can("millreceipt.write") && (
                                <Button size="sm" variant="secondary" icon={<PhoneCall className="h-3.5 w-3.5" />} onClick={() => setNoting(m)}>{t("fu.noteCall")}</Button>
                              )}
                              {m.balancePaise > 0 && (
                                <Button size="sm" variant="ghost" icon={<MessageCircle className="h-3.5 w-3.5" />} onClick={() => setMessaging(m)} title={t("fu.message")} aria-label={t("fu.message")} />
                              )}
                              {can("millreceipt.write") && m.balancePaise > 0 && (
                                <Button size="sm" variant="ghost" icon={<Wallet className="h-3.5 w-3.5" />} onClick={() => setReceiving(m.id)} title={t("fu.moneyCame")} aria-label={t("fu.moneyCame")} />
                              )}
                            </div>
                          </Td>
                        </Tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={8} className="border-b border-line bg-raised/40 px-10 py-2">
                              <table className="w-full max-w-3xl text-[12px]">
                                <thead>
                                  <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                                    <th className="py-1 pr-3">{t("fu.parcha")}</th><th className="py-1 pr-3">{t("fu.date")}</th><th className="py-1 pr-3">{t("fu.truck")}</th>
                                    <th className="py-1 pr-3 text-right">{t("fu.bill")}</th><th className="py-1 pr-3 text-right">{t("fu.stillDue")}</th><th className="py-1 text-right">{t("fu.age")}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {m.unpaid.map((u, i) => (
                                    <tr key={u.loadId ?? `opening-${i}`} className="border-t border-line/60">
                                      <td className="py-1 pr-3 font-medium text-ink">{u.parchaNo ? `#${u.parchaNo}` : t("fu.opening")}</td>
                                      <td className="num py-1 pr-3">{u.date ? dmy(u.date) : "—"}</td>
                                      <td className="py-1 pr-3">{u.truckNo ?? "—"}</td>
                                      <td className="num py-1 pr-3 text-right">{f.money(u.billPaise)}</td>
                                      <td className="num py-1 pr-3 text-right font-semibold text-ink">{f.money(u.duePaise)}</td>
                                      <td className="py-1 text-right"><Badge tone={ageTone(u.days)}>{u.days === null ? "—" : t("fu.days", { n: u.days })}</Badge></td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
          <p className="mt-3 text-[12px] text-muted">{t("fu.howPaid")}</p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: "brand" | "ok" | "warn" | "bad" }) {
  return (
    <Card>
      <div className="p-4">
        <p className="text-[12px] font-medium uppercase tracking-wide text-muted">{label}</p>
        <p className={cn("num mt-1 text-2xl font-semibold", tone === "brand" ? "text-ink" : `text-${tone}`)}>{value}</p>
        <p className="mt-1 text-[12px] text-muted">{sub}</p>
      </div>
    </Card>
  );
}

/** The money owed split by age: green (fresh) to red (old). */
function AgeBar({ buckets, labels, className }: { buckets: number[]; labels: string[]; className?: string }) {
  const total = buckets.reduce((s, b) => s + b, 0);
  const colors = ["bg-ok", "bg-warn/70", "bg-warn", "bg-bad"];
  if (!total) return <div className={cn("h-2 rounded-full bg-line", className)} />;
  return (
    <div className={cn("flex h-2 overflow-hidden rounded-full bg-line", className)}>
      {buckets.map((b, i) => b > 0 && <span key={i} title={labels[i]} className={colors[i]} style={{ width: `${(b / total) * 100}%` }} />)}
    </div>
  );
}

/** Note a call or visit: what was said, a promised amount, when to ask again. */
function NoteDialog({ mill, onClose }: { mill: FollowRow; onClose: () => void }) {
  const { t, pick } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const ask = useConfirm();
  const [note, setNote] = useState("");
  const [promised, setPromised] = useState<number | null>(null);
  const [next, setNext] = useState(plusDays(3));
  const [err, setErr] = useState<string | null>(null);
  const hist = useQuery({ queryKey: ["mill-followup", "notes", mill.id], queryFn: () => api.get<{ rows: Note[] }>(`/mill-followup/notes/${mill.id}`) });
  const save = useMutation({
    mutationFn: () => api.post("/mill-followup/notes", { merchantId: mill.id, note: note.trim() || null, promisedPaise: promised ? Math.round(promised * 100) : null, nextDate: next || null }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["mill-followup"] }); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/mill-followup/notes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mill-followup"] }),
  });
  return (
    <Dialog open onClose={onClose} wide title={t("fu.noteTitle", { mill: `${mill.code} — ${pick(mill.name, mill.nameHi)}` })}
      sub={t("fu.noteSub", { a: f.money(mill.balancePaise) })}
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} loading={save.isPending} disabled={!note.trim() && !promised && !next}
          onClick={() => { setErr(null); save.mutate(); }}>{t("fu.saveNote")}</Button>
      </>}>
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      <div className="space-y-4">
        <Field label={t("fu.whatSaid")}>
          <Textarea autoFocus rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={t("fu.whatSaidPh")} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("fu.promisedAmt")} hint={t("common.optional")}>
            <NumberInput value={promised} decimals={2} onValueChange={setPromised} placeholder="0.00"
              className="h-9.5 w-full rounded-lg border bg-surface px-3 text-right text-sm tabular-nums text-ink focus:border-brand" />
          </Field>
          <Field label={t("fu.nextDate")}>
            <Input type="date" value={next} min={todayISO()} onChange={(e) => setNext(e.target.value)} className="num" />
            <div className="mt-1.5 flex flex-wrap gap-1">
              {[1, 3, 7, 15].map((n) => (
                <button key={n} type="button" onClick={() => setNext(plusDays(n))}
                  className={cn("rounded-md border px-2 py-0.5 text-[11px]", next === plusDays(n) ? "border-brand bg-brand/10 text-brand" : "border-line text-muted hover:text-ink")}>
                  {n === 1 ? t("fu.tomorrow") : t("fu.inDays", { n })}
                </button>
              ))}
              <button type="button" onClick={() => setNext("")} className={cn("rounded-md border px-2 py-0.5 text-[11px]", !next ? "border-brand bg-brand/10 text-brand" : "border-line text-muted hover:text-ink")}>{t("fu.noNext")}</button>
            </div>
          </Field>
        </div>
        <div>
          <p className="mb-1.5 text-[12px] font-semibold text-ink">{t("fu.history")}</p>
          {hist.isLoading ? <Spinner /> : !hist.data?.rows.length ? <p className="text-[12px] text-muted">{t("fu.noHistory")}</p> : (
            <ul className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
              {hist.data.rows.map((n) => (
                <li key={n.id} className="flex items-start justify-between gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[12px]">
                  <span className="min-w-0">
                    <span className="num text-muted">{new Date(n.createdAt * 1000).toLocaleDateString("en-GB").replace(/\//g, "-")}{n.byName ? ` · ${n.byName}` : ""}</span>
                    {n.note && <span className="ml-1.5 text-ink">{n.note}</span>}
                    {n.promisedPaise ? <span className="ml-1.5 text-brand">{t("fu.promised", { a: f.money(n.promisedPaise) })}</span> : null}
                    {n.nextDate && <span className="ml-1.5 text-muted">→ {dmy(n.nextDate)}</span>}
                  </span>
                  <button type="button" title={t("common.delete")} aria-label={t("common.delete")} className="shrink-0 text-faint hover:text-bad"
                    onClick={async () => { if (await ask({ title: t("fu.deleteNote"), danger: true, confirmLabel: t("common.delete") })) del.mutate(n.id); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** A reminder to send the mill: copy it, or open WhatsApp with it. */
function MessageDialog({ mill, onClose }: { mill: FollowRow; onClose: () => void }) {
  const { t, pick, lang } = useI18n();
  const f = useFormat();
  const { me } = useSession();
  const [msgLang, setMsgLang] = useState<"hi" | "en">(lang === "hi" ? "hi" : "en");
  const biz = me?.business;
  const from = msgLang === "hi" ? biz?.nameHi || biz?.name || "" : biz?.name || "";
  const bills = mill.unpaid.slice().reverse().slice(0, 12)
    .map((u) => (u.parchaNo ? `#${u.parchaNo} (${u.date ? dmy(u.date) : ""}) ${f.money(u.duePaise)}` : `${msgLang === "hi" ? "पिछला बकाया" : "Old balance"} ${f.money(u.duePaise)}`));
  const who = mill.contactPerson ? (msgLang === "hi" ? `${mill.contactPerson} जी` : mill.contactPerson) : (msgLang === "hi" ? "जी" : "Sir");
  const text = msgLang === "hi"
    ? `नमस्ते ${who}।\n${from} की ओर से: ${pick(mill.name, mill.nameHi)} का ${f.money(mill.balancePaise)} बाक़ी है।\nबाक़ी पर्चे:\n${bills.join("\n")}\nकृपया भुगतान करवा दें। धन्यवाद।`
    : `Namaste ${who}.\nFrom ${from}: ${mill.name} has ${f.money(mill.balancePaise)} due.\nUnpaid parchas:\n${bills.join("\n")}\nPlease arrange the payment. Thank you.`;
  const digits = (mill.phone ?? "").replace(/\D/g, "");
  const phone = digits.length === 10 ? `91${digits}` : digits.length === 12 && digits.startsWith("91") ? digits : "";
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open onClose={onClose} title={t("fu.messageTitle", { mill: mill.code })} sub={t("fu.messageSub")}
      footer={<>
        <Button variant="secondary" icon={<Copy className="h-4 w-4" />} onClick={async () => {
          try { await navigator.clipboard.writeText(text); setCopied(true); } catch { toastError(t("fu.copyFailed")); }
        }}>{copied ? t("fu.copied") : t("fu.copy")}</Button>
        {phone && (
          <Button variant="primary" icon={<MessageCircle className="h-4 w-4" />}
            onClick={() => window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, "_blank", "noopener")}>
            {t("fu.whatsapp")}
          </Button>
        )}
      </>}>
      <div className="mb-2 inline-flex rounded-lg border border-line p-0.5 text-[12px]">
        {(["hi", "en"] as const).map((l) => (
          <button key={l} type="button" onClick={() => setMsgLang(l)}
            className={cn("rounded-md px-2.5 py-1", msgLang === l ? "bg-raised font-semibold text-ink" : "text-muted")}>{l === "hi" ? "हिन्दी" : "English"}</button>
        ))}
      </div>
      <pre className="whitespace-pre-wrap rounded-lg border border-line bg-raised/40 p-3 font-sans text-[13px] leading-relaxed text-ink" lang={msgLang}>{text}</pre>
      {!phone && <p className="mt-2 text-[12px] text-muted">{t("fu.noPhone")}</p>}
    </Dialog>
  );
}
