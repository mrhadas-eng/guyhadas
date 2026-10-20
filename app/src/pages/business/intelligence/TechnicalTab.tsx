import { Fragment, useMemo, useState } from "react";
import { EmptyState } from "../../../components/EmptyState";
import { StatCard } from "../../../components/StatCard";
import { Pager, usePagination } from "../../../components/ui/Pager";
import { StatusPill } from "../../../components/ui/StatusPill";
import { Disclosure } from "../../../components/ui/Disclosure";
import { FINDING_TEXT, IMPORTANT, INFO_COPY, ISSUE_COPY, PRIORITY_DISPLAY, REVIEW, ROLE_LABELS, canonicalState, indexState, internalLinks, pageLabel, pagePriority, pagesCount, presenceState, structuredState, when } from "../../../lib/plainLanguage";
import type { PagePriority } from "../../../lib/plainLanguage";
import type { StatusTone } from "../../../components/ui/StatusPill";
import type { SeoPage } from "../../../types";

const PAGE_SIZE = 15;
type Filter = "all" | "important" | "check" | "not_indexable" | "not_in_sitemap" | "not_crawled";
const PRIORITY_ORDER: Record<PagePriority, number> = { important: 0, check: 1, ok: 2 };

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "הכל" },
  { id: "important", label: "בעיות חשובות" },
  { id: "check", label: "נקודות לבדיקה" },
  { id: "not_indexable", label: "לא יכולים להיכלל בגוגל" },
  { id: "not_in_sitemap", label: "לא במפת האתר" },
  { id: "not_crawled", label: "לא נבדקו בריצה האחרונה" }
];

// Green stays quiet (plain check mark); only yellow/red get a pill, so the
// eye lands on what matters.
// `secondary` columns (sitemap, structured data, internal links) are
// supporting detail: never a pill, so they don't compete with the status
// and the two primary checks.
function Signal({ tone, text, secondary = false }: { tone: StatusTone; text: string; secondary?: boolean }) {
  if (secondary) {
    const glyph = tone === "good" ? "✓" : tone === "neutral" ? "–" : tone === "bad" ? "✕" : "!";
    return <span className={`signal-secondary ${tone}`}><span aria-hidden="true">{glyph}</span> {text}</span>;
  }
  if (tone === "good") return <span className="signal-ok"><span aria-hidden="true">✓</span> {text}</span>;
  if (tone === "neutral") return <span className="signal-muted">{text}</span>;
  return <StatusPill tone={tone}>{text}</StatusPill>;
}

function PageDetail({ p }: { p: SeoPage }) {
  const level = pagePriority(p);
  const prio = PRIORITY_DISPLAY[level];
  // Findings that make the row red/yellow, most serious first.
  const issues = [...p.diagnostics.filter((d) => IMPORTANT.has(d.code)), ...p.diagnostics.filter((d) => REVIEW.has(d.code))];
  const info = p.diagnostics.filter((d) => !IMPORTANT.has(d.code) && !REVIEW.has(d.code));
  const idx = indexState(p.indexability.state);
  return (
    <div className="row-detail">
      <div className="detail-status">
        <StatusPill tone={prio.tone}>{prio.text}</StatusPill>
        <span>{prio.help}</span>
      </div>

      {issues.length > 0 ? (
        <section className="detail-section">
          <h5 className="detail-heading">{level === "important" ? "מה מצאנו" : "מה כדאי לבדוק"}</h5>
          <ul className="issue-list">
            {issues.map((d) => {
              const c = ISSUE_COPY[d.code];
              return (
                <li key={d.code} className={`issue-item ${IMPORTANT.has(d.code) ? "bad" : "warn"}`}>
                  <div><strong>{c ? c.label : "ממצא"}:</strong> {c ? c.found : FINDING_TEXT[d.code] || d.code}</div>
                  {c && <div className="issue-why">למה זה חשוב: {c.why}</div>}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {info.length > 0 && (
        <section className="detail-section info">
          <h5 className="detail-heading muted">לידיעה בלבד</h5>
          <ul className="info-list">
            {info.map((d) => (
              <li key={d.code}>
                {INFO_COPY[d.code] || FINDING_TEXT[d.code] || d.code}
                {d.basis === "inferred" ? " (הסקת מערכת)" : ""}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="detail-section">
        <h5 className="detail-heading muted">פרטי הדף</h5>
        <div className="detail-grid" style={{ marginTop: 0 }}>
          <div><div className="detail-label">כותרת</div><div>{p.title || "—"}</div></div>
          <div><div className="detail-label">כותרת ראשית</div><div>{p.h1.join(" · ") || "—"}</div></div>
          <div><div className="detail-label">תיאור לתוצאות החיפוש</div><div>{p.metaDescription || "—"}</div></div>
          <div><div className="detail-label">כמות מילים</div><div>{p.wordCount ?? "—"}</div></div>
          <div><div className="detail-label">דפים באתר שמקשרים לדף הזה</div><div>{p.links.inboundInternalCount === 0 ? "אף דף (מבין הדפים שנבדקו)" : `${pagesCount(p.links.inboundInternalCount)} (מבין הדפים שנבדקו)`}</div></div>
          <div><div className="detail-label">סוג הדף</div><div>{ROLE_LABELS[p.role.role] || "אחר"}{p.role.basis === "inferred" ? " (הסקת מערכת)" : ""}</div></div>
          <div>
            <div className="detail-label">יכול להיכלל בגוגל</div>
            <div>{idx.text} <span className="text-dim">- לפי הסריקה. לא נבדק אם Google כבר כלל את הדף בפועל.</span></div>
          </div>
        </div>
      </section>

      <Disclosure label="פרטים טכניים" tone="technical">
        <ul className="tech-list">
          <li dir="ltr">{p.url}</li>
          <li>HTTP {p.httpStatus ?? "—"} · indexability: {p.indexability.state}{p.indexability.reasons.length ? ` (${p.indexability.reasons.join("; ")})` : ""}{p.indexability.scope ? ` · ${p.indexability.scope}` : ""}</li>
          <li>canonical: {p.canonical.state}{p.canonical.target ? ` → ${p.canonical.target}` : ""}</li>
          <li>robots: {p.robots.state}{p.robots.rule ? ` (${p.robots.rule})` : ""}{p.robots.reason ? ` · ${p.robots.reason}` : ""}</li>
          <li>sitemap: {p.sitemap.state}{p.sitemap.reason ? ` · ${p.sitemap.reason}` : ""}</li>
          <li>structured data: {p.structuredData.state}{p.structuredData.types?.length ? ` (${p.structuredData.types.join(", ")})` : ""}</li>
          <li>links: in {p.links.inboundInternalCount} · out {p.links.outboundInternalCount} · external {p.links.externalCount} · {p.links.scope} · orphan: {p.orphan.state}</li>
          <li>role: {p.role.role} ({p.role.basis}: {p.role.rule})</li>
          <li>diagnostics: {p.diagnostics.map((d) => `${d.code}${d.detail ? ` (${d.detail})` : ""}`).join(", ") || "—"}</li>
          <li>crawl: {p.crawlStatus}{p.lastRunReason ? ` · ${p.lastRunReason}` : ""} · {when(p.lastCrawledAtMs)}</li>
        </ul>
      </Disclosure>
    </div>
  );
}

export function TechnicalTab({ pages }: { pages: SeoPage[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const current = pages.filter((p) => p.crawlStatus === "fetched");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pages
      .filter((p) => {
        if (filter === "important") return p.crawlStatus === "fetched" && pagePriority(p) === "important";
        if (filter === "check") return p.crawlStatus === "fetched" && pagePriority(p) === "check";
        if (filter === "not_indexable") return p.crawlStatus === "fetched" && p.indexability.state === "non_indexable";
        if (filter === "not_in_sitemap") return p.crawlStatus === "fetched" && p.sitemap.state === "absent";
        if (filter === "not_crawled") return p.crawlStatus !== "fetched";
        return true;
      })
      .filter((p) => !q || p.url.toLowerCase().includes(q) || (p.title || "").toLowerCase().includes(q) || pageLabel(p).path.toLowerCase().includes(q))
      .sort((a, b) => PRIORITY_ORDER[pagePriority(a)] - PRIORITY_ORDER[pagePriority(b)] || a.url.localeCompare(b.url));
  }, [pages, filter, query]);
  const pager = usePagination(filtered, PAGE_SIZE, `${filter}|${query}`);

  if (pages.length === 0) return <EmptyState title="עדיין לא נבדקו דפים" subtitle="הרץ/י ניתוח כדי לבדוק את דפי האתר." />;

  const count = (fn: (p: SeoPage) => boolean) => current.filter(fn).length;
  return (
    <div>
      <p className="tab-intro">הבדיקה הטכנית של דפי האתר: האם לפי הסריקה אין מניעה טכנית שהדפים ייכללו בגוגל, האם הם מוגדרים נכון, ואיך הם מקושרים זה לזה. זו לא בדיקה של אילו דפים Google כבר כלל בפועל.</p>
      <div className="stat-grid">
        <StatCard label="דפים שנבדקו" value={current.length} />
        <StatCard label="יכולים להיכלל בגוגל (לפי הסריקה)" value={`${count((p) => p.indexability.state === "indexable")}/${current.length}`} />
        <StatCard label="בעיות חשובות" value={count((p) => pagePriority(p) === "important")} />
        <StatCard label="נקודות לבדיקה" value={count((p) => pagePriority(p) === "check")} />
      </div>

      <div className="table-toolbar">
        <div className="filter-chips" role="group" aria-label="סינון דפים">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={`summary-chip ${filter === f.id ? "active" : ""}`} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <input className="select-quiet search-input" placeholder="חיפוש דף…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="חיפוש דף" />
      </div>

      <div className="priority-legend" aria-label="מקרא">
        <span><span className="signal-ok">✓</span> נראה תקין</span>
        <span><StatusPill tone="warn">נקודה לבדיקה</StatusPill> כדאי לבדוק, לא תקלה דחופה</span>
        <span><StatusPill tone="bad">בעיה חשובה</StatusPill> עלולה למנוע מהדף להיכלל בגוגל</span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="אין דפים שמתאימים לסינון" subtitle="נסה/י סינון אחר." />
      ) : (
        <div className="data-table-wrap table-sticky">
          <table className="data-table seo-table">
            <thead>
              <tr>
                <th>דף</th>
                <th>מצב</th>
                <th title="לפי הסריקה שלנו: האם אין בדף מניעה טכנית (כמו הוראה שמבקשת ממנועי חיפוש לא לכלול את הדף) שתמנע מ-Google לכלול אותו. לא נבדק אם Google כבר כלל את הדף בפועל.">יכול להיכלל בגוגל</th>
                <th title="כתובת הדף הראשית ש-Google אמור להכיר בה">כתובת ראשית</th>
                <th>במפת האתר</th>
                <th title="מידע שעוזר למנועי חיפוש להבין את הדף">מידע למנועי חיפוש</th>
                <th title="כמה דפים אחרים באתר מקשרים לדף הזה (מבין הדפים שנבדקו)">קישורים פנימיים</th>
                <th><span className="visually-hidden">פירוט</span></th>
              </tr>
            </thead>
            <tbody>
              {pager.rows.map((p) => {
                const label = pageLabel(p);
                const stale = p.crawlStatus !== "fetched";
                const open = openId === p.id;
                const idx = indexState(p.indexability.state);
                const can = canonicalState(p.canonical.state);
                const sm = presenceState(p.sitemap.state);
                const sd = structuredState(p.structuredData.state);
                const links = internalLinks(p);
                const prio = PRIORITY_DISPLAY[pagePriority(p)];
                return (
                  <Fragment key={p.id}>
                    <tr className={`${open ? "row-open" : ""} ${stale ? "row-stale" : ""}`}>
                      <td className="cell-page">
                        <div className="cell-primary">{label.primary}</div>
                        <div className="cell-secondary">
                          <span dir="auto">{label.path}</span> · {ROLE_LABELS[p.role.role] || "אחר"}
                        </div>
                      </td>
                      <td title={stale ? undefined : prio.help}>
                        {stale ? <span className="signal-muted">לא נבדק בריצה האחרונה</span> : prio.tone === "good" ? <Signal tone="good" text={prio.text} /> : <StatusPill tone={prio.tone}>{prio.text}</StatusPill>}
                      </td>
                      <td><Signal tone={idx.tone} text={idx.text} /></td>
                      <td><Signal tone={can.tone} text={can.text} /></td>
                      <td><Signal tone={sm.tone} text={sm.text} secondary /></td>
                      <td><Signal tone={sd.tone} text={sd.text} secondary /></td>
                      <td><Signal tone={links.tone} text={links.text} secondary /></td>
                      <td style={{ textAlign: "end" }}>
                        <button type="button" className="disclosure" aria-expanded={open} onClick={() => setOpenId(open ? null : p.id)}>
                          פירוט <span className="chev" aria-hidden="true">▾</span>
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="detail-row">
                        <td colSpan={8}><PageDetail p={p} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager {...pager} />
      <p className="text-dim footnote">
        הבדיקה מבוססת על סריקת האתר (עד 50 דפים). ״יכול להיכלל בגוגל״ מתאר רק אם אין מניעה טכנית לפי הסריקה - לא בדקנו אם Google כבר כלל את הדף בפועל. קישורים נספרים רק בין הדפים שנבדקו.
      </p>
    </div>
  );
}
