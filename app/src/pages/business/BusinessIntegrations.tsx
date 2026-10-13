import { useEffect, useState } from "react";
import SemrushBalanceCheck from "./SemrushBalanceCheck";
import { useOutletContext } from "react-router-dom";
import { StatusBadge } from "../../components/StatusBadge";
import { ConnectIntegrationModal } from "../../components/ConnectIntegrationModal";
import { listenIntegrations, listenLatestSemrushBalanceSnapshot } from "../../lib/firestore";
import { deriveSemrushStatus, SEMRUSH_STATUS_CLASS, SEMRUSH_STATUS_LABELS } from "../../lib/semrushStatus";
import type { SemrushBalanceResult } from "../../lib/semrushBalance";
import { disconnectIntegration, syncGa4, syncSearchConsole } from "../../lib/functions";
import { INTEGRATION_LABELS } from "../../types";
import type { Integration, IntegrationProvider } from "../../types";
import type { BusinessContext } from "./BusinessWorkspace";

// Every provider the Visibility OS is meant to support, per the architecture
// spec - shown even before any Firestore doc exists for it, so the business
// owner sees the full planned integration surface, not just what's connected.
const ALL_PROVIDERS: IntegrationProvider[] = ["ga4", "search_console", "semrush", "openai", "anthropic", "xai", "n8n"];

// GA4 and Search Console connect through the dedicated Visibility OS
// service account (Milestone 2). Semrush is ACCOUNT-level: its status comes
// from the free balance check evidence (semrushBalanceSnapshots + a check
// made in this session), not from a per-business integrations record. The
// AI providers / n8n aren't wired up yet.
const GOOGLE_PROVIDERS: IntegrationProvider[] = ["ga4", "search_console"];

function formatTimestamp(value: unknown): string | null {
  const ts = value as { toDate?: () => Date } | null | undefined;
  if (!ts?.toDate) return null;
  return ts.toDate().toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });
}

export default function BusinessIntegrations() {
  const { business } = useOutletContext<BusinessContext>();
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [connectModalProvider, setConnectModalProvider] = useState<"ga4" | "search_console" | null>(null);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [semrushSnapshot, setSemrushSnapshot] = useState<{ checkedAt: string } | null>(null);
  const [semrushSession, setSemrushSession] = useState<SemrushBalanceResult | null>(null);

  useEffect(() => {
    if (!business) return;
    return listenIntegrations(business.id, setIntegrations);
  }, [business]);

  // Account-level Semrush evidence (Firestore read only - no function call).
  useEffect(() => listenLatestSemrushBalanceSnapshot(setSemrushSnapshot), []);

  if (!business) return <div className="loading-row">טוען…</div>;

  const byProvider = new Map((integrations || []).map((i) => [i.provider, i]));
  const semrushStatus = deriveSemrushStatus(semrushSnapshot, semrushSession);

  async function handleSync(provider: "ga4" | "search_console") {
    if (!business) return;
    setBusyProvider(provider);
    setActionError(null);
    try {
      if (provider === "ga4") await syncGa4(business.id);
      else await syncSearchConsole(business.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "שגיאה בסנכרון");
    } finally {
      setBusyProvider(null);
    }
  }

  async function handleDisconnect(provider: "ga4" | "search_console") {
    if (!business) return;
    setBusyProvider(provider);
    setActionError(null);
    try {
      await disconnectIntegration(business.id, provider);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "שגיאה בניתוק");
    } finally {
      setBusyProvider(null);
    }
  }

  return (
    <div className="section-block">
      <h2 className="section-title">אינטגרציות</h2>
      {actionError && <div className="login-error">{actionError}</div>}
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>ספק</th>
              <th>סטטוס</th>
              <th>Property</th>
              <th>סנכרון אחרון</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {ALL_PROVIDERS.map((provider) => {
              const integ = byProvider.get(provider);
              const status = integ?.status || "not_connected";
              const isGoogle = GOOGLE_PROVIDERS.includes(provider);
              const isBusy = busyProvider === provider;
              const lastSynced = formatTimestamp(integ?.lastSyncedAt);

              return (
                <tr key={provider}>
                  <td>{INTEGRATION_LABELS[provider]}</td>
                  <td>
                    {provider === "semrush" ? (
                      <span className={`status-badge ${SEMRUSH_STATUS_CLASS[semrushStatus.status]}`}>{SEMRUSH_STATUS_LABELS[semrushStatus.status]}</span>
                    ) : (
                      <StatusBadge status={status} />
                    )}
                    {status === "error" && integ?.errorMessage && (
                      <div className="text-dim" style={{ fontSize: "0.75rem", marginTop: 4, maxWidth: 260 }}>
                        {integ.errorMessage}
                      </div>
                    )}
                  </td>
                  <td className="text-muted">{integ?.propertyLabel || "—"}</td>
                  <td className="text-muted">{provider === "semrush" ? (semrushStatus.checkedAt ? new Date(semrushStatus.checkedAt).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" }) : "—") : lastSynced || "—"}</td>
                  <td>
                    {isGoogle && (status === "not_connected" || status === "error") && (
                      <button
                        type="button"
                        className="btn btn-outline"
                        onClick={() => setConnectModalProvider(provider as "ga4" | "search_console")}
                      >
                        התחבר
                      </button>
                    )}
                    {isGoogle && status === "connected" && (
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          type="button"
                          className="btn btn-outline"
                          disabled={isBusy}
                          onClick={() => handleSync(provider as "ga4" | "search_console")}
                        >
                          {isBusy ? "מסנכרן…" : "סנכרון עכשיו"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-outline"
                          disabled={isBusy}
                          onClick={() => handleDisconnect(provider as "ga4" | "search_console")}
                        >
                          נתק
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-dim" style={{ fontSize: "0.8rem", marginTop: 12 }}>
        Semrush V4 מחובר. ניתן לבדוק את יתרת יחידות ה-API באמצעות הכפתור למטה. OpenAI / Anthropic / xAI / n8n יתווספו בהמשך.
      </p>

      <SemrushBalanceCheck onResult={setSemrushSession} />

      {connectModalProvider && (
        <ConnectIntegrationModal
          businessId={business.id}
          provider={connectModalProvider}
          onClose={() => setConnectModalProvider(null)}
          onConnected={() => setConnectModalProvider(null)}
        />
      )}
    </div>
  );
}
