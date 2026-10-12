// Shared M7 store-test setup: the Hagar fixture with a 6 Oct analysis and
// baseline, M6 run for real, chosen decisions accepted, store handles.
const F = require("./m7Fixture");
const T = require("../../trackingRules");
const { BIZ, NOW } = F;
const DAY = 86400000;
const TZ = "Asia/Jerusalem";
const RUN1_AT = T.startOfDayMs("2026-10-06", TZ) + 10 * 3600000; // analysis on 6 Oct
const D_RANK = `${BIZ}_intent_${BIZ}_tRank`;
const D_LEARN = `${BIZ}_intent_${BIZ}_tLearn`;
const D_SITE = `${BIZ}_site_fact_consistency`;
const D_GAP = `${BIZ}_intent_${BIZ}_tGap`;
const ARCH = F.keyOf("architecture");

function baselineFrom(f, { id, version, capturedAtMs, sourceRunId, pageKeys = null }) {
  const pages = f.seoPages.filter((p) => !pageKeys || pageKeys.includes(p.pageKey)).map((p) => ({ url: p.url, pageKey: p.pageKey, crawlStatus: "fetched", title: p.title, h1: p.h1 || [], h2: p.h2 || [], indexability: p.indexability.state, canonical: p.canonical.state, robots: p.robots.state, sitemap: "present", structuredData: "missing", structuredDataTypes: [], inboundInternalCount: p.links.inboundInternalCount, orphan: "linked", diagnostics: [] }));
  const topics = f.topicIntel.map((t) => ({ topicId: t.topicId, title: t.title, gscCurrent: t.gscCurrent, semrush: t.semrush }));
  return { businessId: BIZ, baselineId: id, version, immutable: true, capturedAtMs, sourceRunId, pages, topics, referenceKeys: { pageKeys: pages.map((p) => p.pageKey), topicIds: topics.map((t) => t.topicId) } };
}

// mutate(f) may change the fixture; opts.baseline=false seeds no baseline.
async function setup({ mutate = (f) => f, baseline = true, accept = [D_RANK] } = {}) {
  const f = mutate(F.fixture());
  f.run.completedAtMs = RUN1_AT;
  Object.assign(f.run, { analysisVersion: 1, summary: {}, geoReadiness: { summary: {}, signals: [] }, gsc: { status: "available", period: F.PERIOD } });
  f.baseline = null;
  for (const t of f.topicIntel) t.computedAtMs = RUN1_AT;
  for (const p of f.seoPages) p.lastCrawledAtMs = RUN1_AT;
  const { fake, db } = await F.seedStore(f);
  if (baseline) await db.collection("baselines").doc(`${BIZ}_v1`).set(baselineFrom(f, { id: `${BIZ}_v1`, version: 1, capturedAtMs: RUN1_AT + 3600000, sourceRunId: "run1" }));
  await db.collection("businesses").doc(BIZ).update({ website: "https://www.hagarlushi.com", timeZone: TZ });
  for (let i = 0; i < 3; i++) await db.collection("searchSnapshots").doc(`ss${i}`).set({ businessId: BIZ, retrievedAt: RUN1_AT - (3 - i) * DAY, data: { impressions: 4000 + i * 10, clicks: 100 } });
  const m6 = F.loadWithFake(fake, F.DECISION_STORE);
  await m6.runDecisionEngine({ businessId: BIZ, nowMs: NOW });
  for (const id of accept) await db.collection("decisions").doc(id).update({ ownerStatus: "accepted" });
  const store = F.loadWithFake(fake, F.TRACKING_STORE);
  const track = (n = NOW, o = {}) => store.runTracking({ businessId: BIZ, nowMs: n, ...o });
  const record = (body, n = NOW, o = {}) => store.recordImplementation({ businessId: BIZ, body: { ownerAttestation: true, implementationMatch: "full", responsibleActor: { type: "owner" }, ...body }, uid: "owner", nowMs: n, ...o });
  return { f, fake, db, store, track, record, m6, rows: (c) => fake.rows(c) };
}


module.exports = { F, T, BIZ, NOW, DAY, TZ, RUN1_AT, D_RANK, D_LEARN, D_SITE, D_GAP, ARCH, baselineFrom, setup };
