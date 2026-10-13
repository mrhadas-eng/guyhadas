const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { google } = require("googleapis");

admin.initializeApp();
const db = admin.firestore();

// GuyHadas Visibility OS (app.guyhadas.xyz) - Milestone 2 Google data
// connections. Kept in its own file since it's a separate app with its own
// auth model (every function requires a verified Firebase ID token), not
// because of the Calendar/email logic below, which stays untouched.
Object.assign(exports, require("./visibility"));
Object.assign(exports, require("./businessUnderstanding"));
Object.assign(exports, require("./searchUniverse"));
Object.assign(exports, require("./searchIntelligence"));
Object.assign(exports, require("./opportunityEngine"));
Object.assign(exports, require("./decisionEngine"));
Object.assign(exports, require("./trackingEngine"));
// Semrush free balance check (V4-era, read-only; independent of the V3 adapter).
exports.visibilityGetSemrushBalance = require("./semrushBalance").visibilityGetSemrushBalance;
// Semrush V4 Keyword Metrics pilot: governed enrichment of ONE approved query (20 units, explicit owner action).
exports.visibilityEnrichKeywordMetrics = require("./keywordMetrics").visibilityEnrichKeywordMetrics;

const GUY_CALENDAR_EMAIL = "mr.hadas@gmail.com";

// --- JEWISH HOLIDAYS & EREV CHAG CALENDAR (2025 - 2028) ---
// Major holidays, Yom Tov (שבתון), Erev Chag, and National Memorial/Independence days are blocked.
// Chol HaMoed (חוה״מ) and minor fast days (צומות קלים) ARE OPEN for booking.
const JEWISH_HOLIDAYS = {
  // 2025
  "2025-03-14": "פורים", "2025-03-15": "שושן פורים",
  "2025-04-12": "ערב פסח", "2025-04-13": "פסח א׳",
  "2025-04-19": "שביעי של פסח",
  "2025-04-30": "יום הזכרון", "2025-05-01": "יום העצמאות",
  "2025-06-01": "ערב שבועות", "2025-06-02": "חג שבועות",
  "2025-08-02": "ערב תשעה באב", "2025-08-03": "צום תשעה באב",
  "2025-09-22": "ערב ראש השנה", "2025-09-23": "ראש השנה א׳", "2025-09-24": "ראש השנה ב׳",
  "2025-10-01": "ערב יום כיפור", "2025-10-02": "יום כיפור",
  "2025-10-06": "ערב סוכות", "2025-10-07": "סוכות א׳",
  "2025-10-13": "ערב שמחת תורה (הושענא רבה)", "2025-10-14": "שמחת תורה",

  // 2026
  "2026-03-03": "פורים", "2026-03-04": "שושן פורים",
  "2026-04-01": "ערב פסח", "2026-04-02": "פסח א׳",
  "2026-04-08": "שביעי של פסח",
  "2026-04-21": "יום הזכרון", "2026-04-22": "יום העצמאות",
  "2026-05-21": "ערב שבועות", "2026-05-22": "חג שבועות",
  "2026-07-22": "ערב תשעה באב", "2026-07-23": "צום תשעה באב",
  "2026-09-11": "ערב ראש השנה", "2026-09-12": "ראש השנה א׳", "2026-09-13": "ראש השנה ב׳",
  "2026-09-20": "ערב יום כיפור", "2026-09-21": "יום כיפור",
  "2026-09-25": "ערב סוכות", "2026-09-26": "סוכות א׳",
  "2026-10-02": "ערב שמחת תורה (הושענא רבה)", "2026-10-03": "שמחת תורה",

  // 2027
  "2027-03-23": "פורים", "2027-03-24": "שושן פורים",
  "2027-04-21": "ערב פסח", "2027-04-22": "פסח א׳",
  "2027-04-28": "שביעי של פסח",
  "2027-05-11": "יום הזכרון", "2027-05-12": "יום העצמאות",
  "2027-06-10": "ערב שבועות", "2027-06-11": "חג שבועות",
  "2027-08-11": "ערב תשעה באב", "2027-08-12": "צום תשעה באב",
  "2027-10-01": "ערב ראש השנה", "2027-10-02": "ראש השנה א׳", "2027-10-03": "ראש השנה ב׳",
  "2027-10-10": "ערב יום כיפור", "2027-10-11": "יום כיפור",
  "2027-10-15": "ערב סוכות", "2027-10-16": "סוכות א׳",
  "2027-10-22": "ערב שמחת תורה (הושענא רבה)", "2027-10-23": "שמחת תורה",

  // 2028
  "2028-03-12": "פורים", "2028-03-13": "שושן פורים",
  "2028-04-11": "פסח א׳", "2028-04-17": "שביעי של פסח",
  "2028-05-01": "יום הזכרון", "2028-05-02": "יום העצמאות",
  "2028-05-30": "ערב שבועות", "2028-05-31": "חג שבועות",
  "2028-07-31": "ערב תשעה באב", "2028-08-01": "צום תשעה באב",
  "2028-09-20": "ערב ראש השנה", "2028-09-21": "ראש השנה א׳", "2028-09-22": "ראש השנה ב׳",
  "2028-09-29": "ערב יום כיפור", "2028-09-30": "יום כיפור",
  "2028-10-04": "ערב סוכות", "2028-10-05": "סוכות א׳",
  "2028-10-11": "ערב שמחת תורה (הושענא רבה)", "2028-10-12": "שמחת תורה"
};

function getISODateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getJewishHolidayName(d) {
  return JEWISH_HOLIDAYS[getISODateKey(d)] || null;
}

// Firestore Trigger on new booking creation
exports.syncMeetingToGoogleCalendar = functions.firestore
  .document("bookings/{slotId}")
  .onCreate(async (snap, context) => {
    const booking = snap.data();
    if (!booking) return null;

    try {
      // Authenticate with Google Application Default Credentials
      const auth = new google.auth.GoogleAuth({
        scopes: [
          "https://www.googleapis.com/auth/calendar",
          "https://www.googleapis.com/auth/calendar.events"
        ]
      });

      const calendar = google.calendar({ version: "v3", auth });

      const clientName = booking.clientName || "לקוח/ה";
      const clientEmail = booking.clientEmail || "";
      const clientPhone = booking.clientPhone || "";
      const startIso = booking.startIso;
      const endIso = booking.endIso;

      const eventLocation = clientPhone ? `שיחה אישית מול גיא הדס (${clientPhone})` : `שיחה אישית מול גיא הדס`;

      const eventResource = {
        summary: `שיחה עם גיא הדס | ${clientName}`,
        description: `שיחה אישית בת שעה עם גיא הדס (Executive Operations & Execution).\n\nמשתתפים:\n- ${clientName} (טל׳: ${clientPhone}, מייל: ${clientEmail})\n- גיא הדס (טל׳: 052-594-9682, מייל: ${GUY_CALENDAR_EMAIL})\n\nאופן ההתקשרות:\nגיא ייצור קשר טלפוני במספר ${clientPhone || 'של הלקוח'} במועד השיחה, או בקישור וידאו ייעודי שיועבר לקראת הפגישה.\n\nשיחה אישית ודיסקרטית תחת NDA.`,
        location: eventLocation,
        start: {
          dateTime: startIso,
          timeZone: "Asia/Jerusalem"
        },
        end: {
          dateTime: endIso,
          timeZone: "Asia/Jerusalem"
        },
        reminders: {
          useDefault: false,
          overrides: [
            { method: "email", minutes: 24 * 60 },
            { method: "popup", minutes: 30 }
          ]
        }
      };

      // Insert into Guy's Google Calendar
      const res = await calendar.events.insert({
        calendarId: GUY_CALENDAR_EMAIL,
        requestBody: eventResource
      });

      console.log("Successfully created Google Calendar Event:", res.data.id);

      // Update booking and lead documents with the calendar event link
      await snap.ref.update({
        googleCalendarEventId: res.data.id,
        googleCalendarHtmlLink: res.data.htmlLink,
        calendarSynced: true,
        calendarSyncedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      if (booking.leadId) {
        await db.collection("leads").doc(booking.leadId).update({
          googleCalendarEventId: res.data.id,
          meetingSet: true
        });
      }

      return res.data;
    } catch (err) {
      console.error("Error creating Google Calendar Event:", err);
      return null;
    }
  });

// HTTP Callable Endpoint for instant calendar injection from client
exports.createMeetingDirect = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    const { slotData, clientName, clientEmail, clientPhone } = req.body;

    const auth = new google.auth.GoogleAuth({
      scopes: [
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/calendar.events"
      ]
    });

    const calendar = google.calendar({ version: "v3", auth });

    const eventLocation = clientPhone ? `שיחה אישית מול גיא הדס (${clientPhone})` : `שיחה אישית מול גיא הדס`;

    const eventResource = {
      summary: `שיחה עם גיא הדס | ${clientName || 'לקוח'}`,
      description: `שיחה אישית בת שעה עם גיא הדס (Executive Operations & Execution).\n\nמשתתפים:\n- ${clientName} (טל׳: ${clientPhone}, מייל: ${clientEmail})\n- גיא הדס (טל׳: 052-594-9682, מייל: ${GUY_CALENDAR_EMAIL})\n\nאופן ההתקשרות:\nגיא ייצור קשר ישיר בטלפון ${clientPhone || 'של הלקוח'} במועד השיחה, או בקישור וידאו ייעודי שיועבר לקראת הפגישה.\n\nשיחה אישית ודיסקרטית תחת NDA.`,
      location: eventLocation,
      start: {
        dateTime: slotData.startIso,
        timeZone: "Asia/Jerusalem"
      },
      end: {
        dateTime: slotData.endIso,
        timeZone: "Asia/Jerusalem"
      }
    };

    const client = await auth.getClient();
    const serviceAccountEmail = client.email || (await auth.getProjectId());
    console.log("Executing Google Calendar insert as service account:", serviceAccountEmail);

    const calendarRes = await calendar.events.insert({
      calendarId: GUY_CALENDAR_EMAIL,
      requestBody: eventResource
    });

    res.status(200).json({
      success: true,
      eventId: calendarRes.data.id,
      htmlLink: calendarRes.data.htmlLink
    });
  } catch (err) {
    console.error("Direct calendar injection error:", err);
    res.status(500).json({ success: false, error: err.message, details: err.response?.data || null });
  }
});

// Candidate 1-hour slots pool across Israeli working days (Sunday to Thursday, 10:00 - 18:00)
// Ordered by executive preference
const CANDIDATE_SLOTS_POOL = [
  // Primary core preferred slots
  { dayOffset: 1, dayName: 'יום שני', timeStr: '11:00 - 12:00', startHour: 11, startMin: 0, endHour: 12, endMin: 0 },
  { dayOffset: 2, dayName: 'יום שלישי', timeStr: '15:00 - 16:00', startHour: 15, startMin: 0, endHour: 16, endMin: 0 },
  { dayOffset: 4, dayName: 'יום חמישי', timeStr: '10:00 - 11:00', startHour: 10, startMin: 0, endHour: 11, endMin: 0 },

  // Secondary candidate slots across all working days
  { dayOffset: 0, dayName: 'יום ראשון', timeStr: '11:00 - 12:00', startHour: 11, startMin: 0, endHour: 12, endMin: 0 },
  { dayOffset: 3, dayName: 'יום רביעי', timeStr: '14:00 - 15:00', startHour: 14, startMin: 0, endHour: 15, endMin: 0 },
  { dayOffset: 1, dayName: 'יום שני', timeStr: '15:00 - 16:00', startHour: 15, startMin: 0, endHour: 16, endMin: 0 },
  { dayOffset: 4, dayName: 'יום חמישי', timeStr: '14:00 - 15:00', startHour: 14, startMin: 0, endHour: 15, endMin: 0 },
  { dayOffset: 0, dayName: 'יום ראשון', timeStr: '15:00 - 16:00', startHour: 15, startMin: 0, endHour: 16, endMin: 0 },
  { dayOffset: 2, dayName: 'יום שלישי', timeStr: '11:00 - 12:00', startHour: 11, startMin: 0, endHour: 12, endMin: 0 },
  { dayOffset: 3, dayName: 'יום רביעי', timeStr: '11:00 - 12:00', startHour: 11, startMin: 0, endHour: 12, endMin: 0 },
  { dayOffset: 4, dayName: 'יום חמישי', timeStr: '11:30 - 12:30', startHour: 11, startMin: 30, endHour: 12, endMin: 30 },
  { dayOffset: 1, dayName: 'יום שני', timeStr: '10:00 - 11:00', startHour: 10, startMin: 0, endHour: 11, endMin: 0 },
  { dayOffset: 3, dayName: 'יום רביעי', timeStr: '16:00 - 17:00', startHour: 16, startMin: 0, endHour: 17, endMin: 0 },
  { dayOffset: 2, dayName: 'יום שלישי', timeStr: '16:30 - 17:30', startHour: 16, startMin: 30, endHour: 17, endMin: 30 },
  { dayOffset: 0, dayName: 'יום ראשון', timeStr: '16:30 - 17:30', startHour: 16, startMin: 30, endHour: 17, endMin: 30 }
];

const HEBREW_MONTHS = [
  'בינואר', 'בפברואר', 'במרץ', 'באפריל', 'במאי', 'ביוני',
  'ביולי', 'באוגוסט', 'בספטמבר', 'באוקטובר', 'בנובמבר', 'בדצמבר'
];

const HEBREW_MONTHS_SHORT = [
  'ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני',
  'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'
];

function getIsraelTimezoneOffsetHours(date) {
  const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const tzDate = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
  return Math.round((tzDate - utcDate) / 3600000);
}

function formatDateIsoWithOffset(date, hours, minutes, offsetHours) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const sign = offsetHours >= 0 ? "+" : "-";
  const absOffset = String(Math.abs(offsetHours)).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}:${mm}:00${sign}${absOffset}:00`;
}

// HTTP Endpoint: Dynamically checks Google Calendar (mr.hadas@gmail.com) and Firestore bookings
// Blocks all Jewish holidays and always returns 3 working weeks with available slots
exports.getAvailableSlots = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    const now = new Date();
    const jerusalemDateStr = now.toLocaleDateString("en-US", { timeZone: "Asia/Jerusalem" });
    const jerusalemToday = new Date(jerusalemDateStr);
    const currentDay = jerusalemToday.getDay(); // 0 = Sun, 1 = Mon ...
    const daysUntilNextSunday = (7 - currentDay) % 7 || 7;

    const nextSunday = new Date(jerusalemToday);
    nextSunday.setDate(jerusalemToday.getDate() + daysUntilNextSunday);
    nextSunday.setHours(0, 0, 0, 0);

    const endOfLookahead = new Date(nextSunday);
    endOfLookahead.setDate(nextSunday.getDate() + (8 * 7)); // 8 weeks lookahead

    const tzOffset = getIsraelTimezoneOffsetHours(nextSunday);
    const windowStartIso = formatDateIsoWithOffset(nextSunday, 0, 0, tzOffset);
    const windowEndIso = formatDateIsoWithOffset(endOfLookahead, 23, 59, tzOffset);

    // 1. Fetch busy times from Google Calendar
    const busyIntervals = [];

    try {
      const auth = new google.auth.GoogleAuth({
        scopes: [
          "https://www.googleapis.com/auth/calendar",
          "https://www.googleapis.com/auth/calendar.events"
        ]
      });
      const calendar = google.calendar({ version: "v3", auth });

      const calEvents = await calendar.events.list({
        calendarId: GUY_CALENDAR_EMAIL,
        timeMin: windowStartIso,
        timeMax: windowEndIso,
        singleEvents: true,
        orderBy: "startTime"
      });

      if (calEvents.data && calEvents.data.items) {
        for (const ev of calEvents.data.items) {
          if (ev.status === "cancelled") continue;
          if (ev.transparency === "transparent") continue; // "Free" event, doesn't block

          const startStr = ev.start?.dateTime || (ev.start?.date ? `${ev.start.date}T00:00:00+03:00` : null);
          const endStr = ev.end?.dateTime || (ev.end?.date ? `${ev.end.date}T23:59:59+03:00` : null);
          if (startStr && endStr) {
            busyIntervals.push({
              start: new Date(startStr).getTime(),
              end: new Date(endStr).getTime(),
              source: "google_calendar"
            });
          }
        }
      }
      console.log(`Fetched ${busyIntervals.length} busy intervals from Google Calendar.`);
    } catch (calErr) {
      console.warn("Could not fetch Google Calendar events:", calErr.message);
    }

    // 2. Fetch existing bookings from Firestore
    try {
      const bookingsSnap = await db.collection("bookings").get();
      bookingsSnap.forEach(bDoc => {
        const b = bDoc.data();
        if (b.startIso && b.endIso) {
          busyIntervals.push({
            start: new Date(b.startIso).getTime(),
            end: new Date(b.endIso).getTime(),
            source: "firestore_booking",
            slotId: bDoc.id
          });
        }
      });
      console.log(`Total busy intervals (Calendar + Bookings): ${busyIntervals.length}`);
    } catch (dbErr) {
      console.warn("Could not fetch Firestore bookings:", dbErr.message);
    }

    // 3. Look ahead to find 3 working weeks with available non-holiday slots
    const weeks = [];
    const defaultWeekLabels = ["השבוע הבא", "עוד שבוע", "עוד שבועיים"];
    let weekOffset = 0;

    while (weeks.length < 3 && weekOffset < 8) {
      const weekStart = new Date(nextSunday);
      weekStart.setDate(nextSunday.getDate() + (weekOffset * 7));

      const weekEndThursday = new Date(weekStart);
      weekEndThursday.setDate(weekStart.getDate() + 4);

      const startDayNum = weekStart.getDate();
      const endDayNum = weekEndThursday.getDate();
      const monthIndex = weekEndThursday.getMonth();
      const dateRangeLabel = `${startDayNum} - ${endDayNum} ${HEBREW_MONTHS[monthIndex]}`;
      const dateRangeShort = `${startDayNum}-${endDayNum} ${HEBREW_MONTHS_SHORT[monthIndex]}`;

      let weekLabel = defaultWeekLabels[weeks.length] || `${startDayNum}-${endDayNum} ${HEBREW_MONTHS_SHORT[monthIndex]}`;
      if (weekOffset > weeks.length) {
        weekLabel = `${startDayNum}-${endDayNum} ${HEBREW_MONTHS_SHORT[monthIndex]}`;
      }

      // Pick available slots from candidate pool
      const availableSlots = [];
      const usedDays = new Set();

      // Pass 1: Try to pick slots on different non-holiday days
      for (const cand of CANDIDATE_SLOTS_POOL) {
        if (availableSlots.length >= 3) break;
        if (usedDays.has(cand.dayOffset)) continue;

        const slotDate = new Date(weekStart);
        slotDate.setDate(weekStart.getDate() + cand.dayOffset);

        // Skip Jewish holidays and Erev Chag
        if (getJewishHolidayName(slotDate)) continue;

        const slotOffset = getIsraelTimezoneOffsetHours(slotDate);
        const startIso = formatDateIsoWithOffset(slotDate, cand.startHour, cand.startMin, slotOffset);
        const endIso = formatDateIsoWithOffset(slotDate, cand.endHour, cand.endMin, slotOffset);
        const startMs = new Date(startIso).getTime();
        const endMs = new Date(endIso).getTime();

        const isBusy = busyIntervals.some(b => startMs < b.end && endMs > b.start);
        if (!isBusy) {
          const dateKey = `${slotDate.getFullYear()}-${String(slotDate.getMonth() + 1).padStart(2, '0')}-${String(slotDate.getDate()).padStart(2, '0')}`;
          const slotId = `slot_${dateKey}_${String(cand.startHour).padStart(2, '0')}${String(cand.startMin).padStart(2, '0')}`;
          availableSlots.push({
            slotId,
            dayName: cand.dayName,
            dayOffset: cand.dayOffset,
            dateKey,
            dateStr: `${slotDate.getDate()} ${HEBREW_MONTHS[slotDate.getMonth()]} ${slotDate.getFullYear()}`,
            timeStr: cand.timeStr,
            startIso,
            endIso,
            startMs,
            isBooked: false
          });
          usedDays.add(cand.dayOffset);
        }
      }

      // Pass 2: If we still don't have 3 slots, allow a second slot on open non-holiday days
      if (availableSlots.length < 3) {
        for (const cand of CANDIDATE_SLOTS_POOL) {
          if (availableSlots.length >= 3) break;

          const slotDate = new Date(weekStart);
          slotDate.setDate(weekStart.getDate() + cand.dayOffset);

          if (getJewishHolidayName(slotDate)) continue;

          const slotOffset = getIsraelTimezoneOffsetHours(slotDate);
          const startIso = formatDateIsoWithOffset(slotDate, cand.startHour, cand.startMin, slotOffset);
          const endIso = formatDateIsoWithOffset(slotDate, cand.endHour, cand.endMin, slotOffset);
          const startMs = new Date(startIso).getTime();
          const endMs = new Date(endIso).getTime();

          const alreadyAdded = availableSlots.some(s => s.startMs === startMs);
          if (alreadyAdded) continue;

          const isBusy = busyIntervals.some(b => startMs < b.end && endMs > b.start);
          if (!isBusy) {
            const dateKey = `${slotDate.getFullYear()}-${String(slotDate.getMonth() + 1).padStart(2, '0')}-${String(slotDate.getDate()).padStart(2, '0')}`;
            const slotId = `slot_${dateKey}_${String(cand.startHour).padStart(2, '0')}${String(cand.startMin).padStart(2, '0')}`;
            availableSlots.push({
              slotId,
              dayName: cand.dayName,
              dayOffset: cand.dayOffset,
              dateKey,
              dateStr: `${slotDate.getDate()} ${HEBREW_MONTHS[slotDate.getMonth()]} ${slotDate.getFullYear()}`,
              timeStr: cand.timeStr,
              startIso,
              endIso,
              startMs,
              isBooked: false
            });
          }
        }
      }

      if (availableSlots.length > 0) {
        // Sort chronological
        availableSlots.sort((a, b) => a.startMs - b.startMs);

        weeks.push({
          weekIndex: weeks.length,
          weekLabel,
          dateRangeLabel,
          dateRangeShort,
          slots: availableSlots
        });
      }

      weekOffset++;
    }

    res.status(200).json({
      success: true,
      weeks: weeks
    });
  } catch (err) {
    console.error("Error in getAvailableSlots:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Direct White-Label Transactional Email Dispatcher (Zero 3rd-party wrappers)
const nodemailer = require("nodemailer");

// The Gmail App Password used to live here in plain text, committed to the
// repo. It's now read from a Secret Manager secret at runtime instead - see
// functions/.env.example for what to set it to, and the README for the
// one-time `firebase functions:secrets:set` step. That old password should
// be treated as compromised and revoked in the Google Account regardless.
exports.sendEmailDirect = functions
  .runWith({ secrets: ["GMAIL_APP_PASSWORD"] })
  .https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    const { to, subject, html, text, cc, icsContent } = req.body;
    if (!to || !subject || (!html && !text)) {
      res.status(400).json({ success: false, error: "Missing required fields: to, subject, html" });
      return;
    }

    if (!process.env.GMAIL_APP_PASSWORD) {
      console.error("GMAIL_APP_PASSWORD is not set - see functions/.env.example");
      res.status(500).json({ success: false, error: "Email sender is not configured" });
      return;
    }

    // Configure Direct Gmail SMTP Transporter with a Google App Password
    // loaded from Secret Manager (see functions/.env.example), never hardcoded.
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER || GUY_CALENDAR_EMAIL,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });

    const mailOptions = {
      from: `"גיא הדס | Executive Operations" <mr.hadas@gmail.com>`,
      to: to,
      cc: cc || "mr.hadas@gmail.com",
      subject: subject,
      html: html,
      text: text || ""
    };

    // If an iCal calendar invite is provided, attach it as a native calendar REQUEST
    if (icsContent) {
      mailOptions.icalEvent = {
        filename: "invite.ics",
        method: "REQUEST",
        content: icsContent
      };
      mailOptions.alternatives = [
        {
          contentType: 'text/calendar; charset="UTF-8"; method=REQUEST',
          content: Buffer.from(icsContent)
        }
      ];
    }

    const info = await transporter.sendMail(mailOptions);
    console.log("Email dispatched successfully directly from Gmail:", info.messageId);
    res.status(200).json({ success: true, messageId: info.messageId });
  } catch (err) {
    console.error("Error in sendEmailDirect:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
