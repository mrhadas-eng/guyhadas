import { useEffect, useState } from "react";
import { updateSearchTopicStatus, listenKeywordsForTopic } from "../../../lib/firestore";
import {
  TOPIC_STATUS_LABELS,
  DISCOVERY_SOURCE_LABELS,
  QUALIFICATION_LABELS,
  INTENT_LABELS,
  QUALIFICATION_REASON_LABELS
} from "../../../types";
import type { DiscoverySource, Keyword, SearchTopic, TopicQualification, TopicStatus } from "../../../types";
import { Badge, type BadgeTone } from "../../../components/review/Badge";
import { SeedComponentChip } from "./SeedDiscoveryPanel";
import { KeywordMetricsPilot, MarketDemandSummary } from "./KeywordMetricsPilot";

const STATUS_BADGE: Record<TopicStatus, { tone: BadgeTone; icon: string }> = {
  new: { tone: "warn", icon: "!" },
  unsure: { tone: "warn", icon: "?" },
  relevant: { tone: "accent", icon: "✓" },
  priority: { tone: "accent", icon: "★" },
  brand_strategic: { tone: "info", icon: "◆" },
  exclude: { tone: "neutral", icon: "✕" }
};

// Observed visibility (GSC), market demand (Semrush) and the owner's own
// additions are different kinds of evidence - each gets its own badge.
const SOURCE_BADGE: Record<DiscoverySource, { tone: BadgeTone; icon: string; title: string }> = {
  gsc: { tone: "info", icon: "◉", title: "שאילתה שהאתר כבר מופיע עבורה בגוגל (Search Console) - נראות קיימת, לא כל השוק." },
  semrush: { tone: "outline", icon: "◇", title: "ביקוש בשוק שנמצא ב-Semrush מ-seed של שירות מאושר או מהדומיין." },
  manual: { tone: "accent", icon: "●", title: "נוסף ידנית על ידי בעל/ת העסק." },
  website: { tone: "neutral", icon: "–", title: "נוצר בסריקת האתר הישנה (הוצאה משימוש)." },
  competitor: { tone: "outline", icon: "◇", title: "מתחרה." }
};

const QUAL_TONE: Record<TopicQualification, BadgeTone> = { likely_relevant: "accent", needs_review: "neutral", possible_mismatch: "danger" };

export function TopicStatusBadge({ status }: { status: TopicStatus }) {
  const meta = STATUS_BADGE[status];
  return <Badge tone={meta.tone} icon={meta.icon}>{TOPIC_STATUS_LABELS[status]}</Badge>;
}

function topicSources(topic: SearchTopic): DiscoverySource[] {
  if (topic.sources && topic.sources.length) return topic.sources;
  return topic.addedBy === "owner" ? ["manual"] : [topic.source];
}

function fmt(n: number | undefined, digits = 0) {
  return n === undefined || n === null ? "—" : Number(n).toLocaleString("he-IL", { maximumFractionDigits: digits });
}

function KeywordRow({ kw }: { kw: Keyword }) {
  const gsc = kw.sources?.gsc ?? (kw.source === "gsc" ? { metrics: kw.metrics ?? undefined } : undefined);
  const sem = kw.sources?.semrush ?? (kw.source === "semrush" ? { volume: kw.volume ?? undefined, difficulty: kw.difficulty ?? undefined } : undefined);
  const list = (kw.sourceList && kw.sourceList.length ? kw.sourceList : [kw.source]) as DiscoverySource[];
  return (
    <li className="evidence-item" style={{ padding: "6px 12px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <strong>{kw.query}</strong>
        {list.map((s) => (
          <Badge key={s} tone={SOURCE_BADGE[s]?.tone || "outline"} icon={SOURCE_BADGE[s]?.icon} title={SOURCE_BADGE[s]?.title}>
            {DISCOVERY_SOURCE_LABELS[s] || s}
          </Badge>
        ))}
      </div>
      <div className="text-dim" style={{ fontSize: "0.8rem", marginTop: 4, display: "flex", flexWrap: "wrap", gap: 12 }}>
        {gsc?.metrics && (
          <span>GSC: {fmt(gsc.metrics.impressions)} חשיפות · {fmt(gsc.metrics.clicks)} קליקים · מיקום {fmt(gsc.metrics.position, 1)}</span>
        )}
        {sem && (sem.volume !== undefined || sem.position !== undefined) && (
          <span>
            Semrush: נפח {fmt(sem.volume)} · קושי {fmt(sem.difficulty)}
            {sem.position !== undefined ? ` · מיקום הדומיין ${fmt(sem.position)}` : ""}
            {sem.report ? ` (${sem.report})` : ""}
          </span>
        )}
        {kw.grouping && kw.grouping.rule !== "new_topic" && (
          <span>
            קובץ לנושא: {kw.grouping.rule === "exact" ? "התאמה מדויקת" : kw.grouping.rule === "title_token_overlap" ? `חפיפת מילים לכותרת (${kw.grouping.score})` : "כבר שויך"}
          </span>
        )}
        {kw.seedRefs && kw.seedRefs.length > 0 && <span>seed: {kw.seedRefs.map((r) => r.phrase).join(", ")}</span>}
      </div>
      {kw.marketDemand && (
        <div style={{ marginTop: 4 }}>
          <MarketDemandSummary md={kw.marketDemand} />
        </div>
      )}
    </li>
  );
}

// A search topic sits ABOVE its raw queries: status + per-source badges,
// explained preliminary qualification, the seed/service it came from, and
// on demand the raw queries with each source's own evidence.
export function SearchTopicCard({ topic }: { topic: SearchTopic }) {
  const [open, setOpen] = useState(false);
  const [keywords, setKeywords] = useState<Keyword[] | null>(null);
  const inReview = topic.status === "new" || topic.status === "unsure";
  const approved = topic.status === "relevant" || topic.status === "priority" || topic.status === "brand_strategic";
  const cardClass = inReview ? "needs-review" : topic.status === "exclude" ? "rejected" : "confirmed";
  const set = (status: TopicStatus) => updateSearchTopicStatus(topic.id, status);

  // Firestore listener only while expanded - no provider call involved.
  useEffect(() => {
    if (!open) return;
    return listenKeywordsForTopic(topic.id, setKeywords);
  }, [open, topic.id]);

  const services = [...new Set((topic.seedRefs || []).map((r) => r.serviceName))];

  return (
    <article className={`record-card ${cardClass}`}>
      <div className="record-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h4 className="record-title" style={{ fontSize: "1rem" }}>{topic.title}</h4>
          <div className="record-badges">
            <TopicStatusBadge status={topic.status} />
            {topicSources(topic).map((s) => (
              <Badge key={s} tone={SOURCE_BADGE[s]?.tone || "outline"} icon={SOURCE_BADGE[s]?.icon} title={SOURCE_BADGE[s]?.title}>
                {s === "manual" ? "בעל/ת העסק" : DISCOVERY_SOURCE_LABELS[s]}
              </Badge>
            ))}
            {topic.qualification && (
              <Badge tone={QUAL_TONE[topic.qualification]} title="סיווג ראשוני אוטומטי עם הסבר - לא החלטה. ההחלטה שלך.">
                {QUALIFICATION_LABELS[topic.qualification]}
              </Badge>
            )}
            {topic.preliminaryIntent && topic.preliminaryIntent !== "unclassified" && (
              <Badge tone="outline" title="כוונת חיפוש ראשונית לפי מילות מפתח בלבד">{INTENT_LABELS[topic.preliminaryIntent]}</Badge>
            )}
          </div>
          {services.length > 0 && (
            <div className="text-dim" style={{ fontSize: "0.8rem", marginTop: 6 }}>מקור: {services.join(" · ")}</div>
          )}
        </div>
        <label className="inline-field-label">
          סטטוס
          <select className="select-quiet" value={topic.status} onChange={(e) => set(e.target.value as TopicStatus)}>
            {Object.entries(TOPIC_STATUS_LABELS).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </label>
      </div>

      {topic.notes && <p className="record-desc">{topic.notes}</p>}

      {open && (
        <div style={{ marginTop: "var(--space-3)" }}>
          {topic.qualificationReasons && topic.qualificationReasons.length > 0 && (
            <div className="text-dim" style={{ fontSize: "0.82rem", marginBottom: 8 }}>
              למה הסיווג: {topic.qualificationReasons.map((r) => QUALIFICATION_REASON_LABELS[r.code] + (r.detail ? ` („${r.detail}“)` : "")).join(" · ")}
            </div>
          )}
          {topic.seedRefs && topic.seedRefs.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {topic.seedRefs.slice(0, 3).flatMap((r) => r.components.map((c, i) => <SeedComponentChip key={`${r.seedKey}-${i}`} c={c} />))}
            </div>
          )}
          <ul className="evidence-list">
            {keywords === null && <li className="evidence-item">טוען שאילתות…</li>}
            {keywords?.map((k) => (
              <KeywordRow key={k.id} kw={k} />
            ))}
            {keywords !== null &&
              topic.queries
                .filter((q) => !keywords.some((k) => k.query === q))
                .map((q) => (
                  <li key={q} className="evidence-item" style={{ padding: "6px 12px" }}>{q}</li>
                ))}
          </ul>
          {approved && keywords && keywords.length > 0 && <KeywordMetricsPilot topic={topic} keywords={keywords} />}
        </div>
      )}

      <div className="record-foot">
        <div className="record-actions">
          {inReview && (
            <>
              <button type="button" className="btn btn-confirm btn-sm" onClick={() => set("relevant")}>✓ רלוונטי</button>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => set("priority")}>★ עדיפות</button>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => set("exclude")}>החרגה</button>
            </>
          )}
        </div>
        <button type="button" className="disclosure" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          שאילתות ומקורות ({topic.queries.length}) <span className="chev" aria-hidden="true">▾</span>
        </button>
      </div>
    </article>
  );
}
