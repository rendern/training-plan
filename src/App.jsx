import { useState, useCallback, useMemo } from "react";

// ── CONSTANTS ─────────────────────────────────────────────────────────────
const BASE_FTP = 238;
const START = new Date(2026, 4, 4); // May 4
const DAY_NAMES = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const RETEST_WEEKS = new Set([14, 22, 30]);

const PHASES = [
  { id:"trans",  name:"Transition",     weeks:[1,2],   color:"#64748B", bg:"#1E293B" },
  { id:"base",   name:"Polarized Base", weeks:[3,14],  color:"#0D9488", bg:"#0F3D38" },
  { id:"ss",     name:"Sweet Spot",     weeks:[15,22], color:"#3B82F6", bg:"#1E3A5F" },
  { id:"thresh", name:"Threshold",      weeks:[23,30], color:"#F97316", bg:"#431407" },
  { id:"vo2",    name:"VO2 Peak",       weeks:[31,36], color:"#EF4444", bg:"#450A0A" },
  { id:"taper",  name:"Taper",          weeks:[37,38], color:"#A855F7", bg:"#2D1B69" },
];

const TYPE = {
  REST:  { color:"#334155", bg:"#0F172A", icon:"🌙", label:"Rest"   },
  Z1:    { color:"#60A5FA", bg:"#0C1E35", icon:"💧", label:"Z1"     },
  Z2:    { color:"#34D399", bg:"#0C2318", icon:"🟢", label:"Z2"     },
  SS:    { color:"#FB923C", bg:"#231500", icon:"🔶", label:"SS"     },
  Z4:    { color:"#F87171", bg:"#200A0A", icon:"🔥", label:"Z4"     },
  Z5:    { color:"#C084FC", bg:"#180D24", icon:"⚡", label:"VO2"    },
  FREE:  { color:"#60A5FA", bg:"#0A1929", icon:"⭐", label:"Free"   },
  LIFT:  { color:"#FBBF24", bg:"#1C1200", icon:"🏋️", label:"Lift"  },
  TEST:  { color:"#FF6B6B", bg:"#2D0000", icon:"🔬", label:"Retest" },
};

const DISRUPTION_PROTOCOL = [
  { q:"Missed 1 session",
    a:"Skip it. Don't squeeze it into the next day. One missed session is noise — continue as normal." },
  { q:"Missed 2+ sessions in a week — treat as recovery week",
    a:"Replace remaining sessions with the recovery week template:\n- Cycling: Z2 only, no quality sessions, no sprints\n- Long ride: keep it but at the shorter end of the duration range\n- Lifting: one trimmed upper session only, no lower body\n- No threshold, no VO2, no sweet spot\nResume the following week where you left off. Only redo the week if severely disrupted (see below)." },
  { q:"Missed an entire week or severely disrupted",
    a:"Option 1 - Skip it: Cut next week volume by 30% as re-entry, then resume. Use when disruption was illness or truly unavoidable.\nOption 2 - Redo it: Tap the week dates in the week bar to set a new start date and repeat the week. Use when you ran out of time but feel physically ready to do the work.\nEither way, never cram missed sessions into the following week." },
  { q:"Post-call day",
    a:"Automatic Z1 or rest regardless of what the plan says. The plan flexes around your roster, not the other way around." },
  { q:"2+ disrupted weeks in one phase",
    a:"Extend that phase by the number of disrupted weeks before moving on. A threshold phase losing 2 weeks runs for 10 weeks, not 8. Tap the week dates to push subsequent weeks forward." },
  { q:"Unusual fatigue mid-phase",
    a:"Take 2-3 consecutive easy days (Z1/rest only) before resuming. If fatigue persists beyond 5 days, treat it as a missed week and follow that rule." },
  { q:"What to drop first when the week gets squeezed",
    a:"1st drop: Weekend free ride or one weekday Z2.\n2nd drop: One lifting session - lower body before upper body.\n3rd drop (last resort): Second lifting session.\nNever drop: Tuesday quality session or Saturday long ride." },
];

// ── UTILS ─────────────────────────────────────────────────────────────────
function getPhase(wn) { return PHASES.find(p => wn >= p.weeks[0] && wn <= p.weeks[1]) || PHASES[0]; }

// Get the Monday start date for a week, respecting any custom override
function getWeekStart(wi, weekDates) {
  if (weekDates && weekDates[wi]) {
    return new Date(weekDates[wi] + 'T00:00:00');
  }
  const d = new Date(START);
  d.setDate(d.getDate() + wi * 7);
  return d;
}

function getDateForDay(wi, di, weekDates) {
  const start = getWeekStart(wi, weekDates);
  const d = new Date(start);
  d.setDate(d.getDate() + di);
  return d;
}

function fmtDate(d, opts = { month:"short", day:"numeric" }) { return d.toLocaleDateString("en-US", opts); }
function toISODate(d) { return d.toISOString().slice(0, 10); }

// ── LOCALSTORAGE ──────────────────────────────────────────────────────────
const LS_KEY = "training-plan-v2-data";
function lsLoad() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}
function lsSave(data) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch {}
}

// ── COMPLIANCE HELPERS ────────────────────────────────────────────────────
// Status cycle: null → "done" → "modified" → "skipped" → null
const STATUS_CYCLE = [null, "done", "modified", "skipped"];
const STATUS_UI = {
  null:     { label:"–",  color:"#334155", bg:"#0F172A", border:"#1E293B" },
  done:     { label:"✓",  color:"#34D399", bg:"#0F2918", border:"#166534" },
  modified: { label:"~",  color:"#F97316", bg:"#1A0A00", border:"#7C2D12" },
  skipped:  { label:"✗",  color:"#F87171", bg:"#200A0A", border:"#7F1D1D" },
};
function nextStatus(cur) {
  const i = STATUS_CYCLE.indexOf(cur);
  return STATUS_CYCLE[(i + 1) % STATUS_CYCLE.length];
}
function compKey(wi, di, si) { return `${wi}-${di}-${si}`; }

// Week compliance: { done, modified, skipped, total }
function weekCompliance(plan, wi, compliance) {
  let done = 0, modified = 0, skipped = 0, total = 0;
  plan[wi].forEach((sessions, di) => sessions.forEach((s, si) => {
    if (!s.dur) return;
    total++;
    const st = compliance[compKey(wi, di, si)];
    if (st === "done") done++;
    else if (st === "modified") modified++;
    else if (st === "skipped") skipped++;
  }));
  return { done, modified, skipped, total, logged: done + modified + skipped };
}

// Phase compliance %
function phaseCompliance(plan, ph, compliance) {
  let done = 0, total = 0;
  for (let wn = ph.weeks[0]; wn <= ph.weeks[1]; wn++) {
    const wi = wn - 1;
    if (!plan[wi]) continue;
    plan[wi].forEach((sessions, di) => sessions.forEach((s, si) => {
      if (!s.dur) return;
      total++;
      const st = compliance[compKey(wi, di, si)];
      if (st === "done" || st === "modified") done++;
    }));
  }
  return total > 0 ? Math.round(done / total * 100) : null;
}
function fmtEndTime(dur) {
  if (!dur) return null;
  const e = 4 * 60 + 30 + dur;
  return `${Math.floor(e / 60)}:${String(e % 60).padStart(2, "0")} AM`;
}

// FTP helpers
const makeZw = (ftp) => (lo, hi) => {
  const lo_w = Math.round(ftp * lo / 100);
  if (!hi) return `>${lo_w}W`;
  return `${lo_w}–${Math.round(ftp * hi / 100)}W`;
};

function getFtpForWeek(wn, cps) {
  // cps = [base, after_W14, after_W22, after_W30]
  if (wn >= 31 && cps[3]) return cps[3];
  if (wn >= 23 && cps[2]) return cps[2];
  if (wn >= 15 && cps[1]) return cps[1];
  return cps[0];
}

// ── CALENDAR UTILS ────────────────────────────────────────────────────────
function gcalUrl(ev) {
  const pad = n => String(n).padStart(2, "0");
  const fmt = d => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
  const s = new Date(ev.date); s.setHours(4, 30, 0, 0);
  const e = new Date(s.getTime() + ev.dur * 60000);
  return `https://calendar.google.com/calendar/render?` + new URLSearchParams({
    action:"TEMPLATE", text:ev.title, dates:`${fmt(s)}/${fmt(e)}`,
    details: ev.desc + `\n\nPhase: ${ev.phase} | Duration: ${ev.dur} min | FTP: ${ev.ftp}W`,
  }).toString();
}

function buildICS(events) {
  const pad = n => String(n).padStart(2, "0");
  const fmt = d => `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
  const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2)}@training`;
  const esc = s => s.replace(/,/g,"\\,").replace(/;/g,"\\;").replace(/\n/g,"\\n");
  const now = new Date().toISOString().replace(/[-:]/g,"").split(".")[0] + "Z";
  const vevents = events.map(ev => {
    const s = new Date(ev.date); s.setHours(4, 30, 0, 0);
    const e = new Date(s.getTime() + ev.dur * 60000);
    return ["BEGIN:VEVENT", `UID:${uid()}`, `DTSTAMP:${now}`,
      `DTSTART:${fmt(s)}`, `DTEND:${fmt(e)}`,
      `SUMMARY:${esc(ev.title)}`, `DESCRIPTION:${esc(ev.desc)}`,
      "BEGIN:VALARM","TRIGGER:-PT15M","ACTION:DISPLAY",
      `DESCRIPTION:${esc(ev.title)} in 15 min`,"END:VALARM","END:VEVENT"].join("\r\n");
  });
  return ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Training Plan v2//EN",
    "CALSCALE:GREGORIAN","METHOD:PUBLISH",...vevents,"END:VCALENDAR"].join("\r\n");
}

// Creates the right type of URL for the current platform:
// iOS Safari needs a data: URI, Mac/desktop works better with a Blob URL
function makeICSLink(str, name) {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isIOS) {
    return { url: 'data:text/calendar;charset=utf-8,' + encodeURIComponent(str), name, blob: null };
  } else {
    const b = new Blob([str], { type:"text/calendar;charset=utf-8" });
    return { url: URL.createObjectURL(b), name, blob: b };
  }
}

// ── LIFT SCHEME HELPER ────────────────────────────────────────────────────
function getLiftScheme(gW) {
  if (gW <= 5)  return "acc";
  if (gW <= 9)  return "int";
  if (gW <= 13) return "peak";
  return "acc2";
}
const SCHEMES = {
  acc:  { u1:"5×10", u2:"3×12", l1:"4×8",  l2:"3×8",  note:"Accumulation — add weight when all reps are clean." },
  int:  { u1:"5×6",  u2:"3×8",  l1:"4×6",  l2:"3×6",  note:"Intensification — ~85% 1RM. Heavier loads, fewer reps." },
  peak: { u1:"5×5",  u2:"3×6",  l1:"4×4",  l2:"3×5",  note:"Peak — near-maximal. Rest fully between sets." },
  acc2: { u1:"5×10", u2:"3×12", l1:"4×8",  l2:"3×8",  note:"Accumulation reset — same rep scheme, heavier baseline than W1." },
};

// ── BUILD PLAN ────────────────────────────────────────────────────────────
function buildPlan(checkpoints) {
  const weeks = [];

  // Per-week FTP and zone calculator
  const zwW = (wn) => makeZw(getFtpForWeek(wn, checkpoints));

  // ── LIFT SESSION LIBRARY ─────────────────────────────────────────────
  const lift = {
    upperA: (full = true, scheme = "acc") => {
      const s = SCHEMES[scheme] || SCHEMES.acc;
      return {
        type:"LIFT",
        title: full ? `Upper A — Horizontal (${scheme.toUpperCase()})` : `Upper A — Trimmed (${scheme.toUpperCase()})`,
        desc: full
          ? `${s.note}\nSS1: Bench Press ${s.u1} / Barbell Row ${s.u1}\nSS2: Dips ${s.u2} / Chest-Supported DB Row ${s.u2}\nCORE: Dead Bug 3×8 · Ab Wheel 3×8 · McGill Curl-Up 2×8`
          : `${s.note}\nSS1: Bench Press ${s.u1} / Barbell Row ${s.u1}\nCORE: Dead Bug 3×8 · Ab Wheel 3×8 · McGill Curl-Up 2×8\n(SS2 skipped)`,
        dur: full ? 55 : 35,
      };
    },
    upperB: (full = true, scheme = "acc") => {
      const s = SCHEMES[scheme] || SCHEMES.acc;
      const pullupDesc = scheme === "acc" || scheme === "acc2"
        ? "Pull-Up 5×max reps (stop 1–2 short of failure — add weight when consistently hitting 8+)"
        : scheme === "int"
        ? "Weighted Pull-Up 5×4–6 (add load that limits you to 4–6 clean reps)"
        : "Weighted Pull-Up 5×3–4 (near-maximal load — full rest between sets)";
      return {
        type:"LIFT",
        title: full ? `Upper B — Vertical (${scheme.toUpperCase()})` : `Upper B — Trimmed (${scheme.toUpperCase()})`,
        desc: full
          ? `${s.note}\nSS1: Strict OHP ${s.u1} / ${pullupDesc}\nSS2: DB Lateral Raise ${s.u2} / Band Face Pull ${s.u2}\nCORE: Pallof Press 3×10 · Suitcase Carry 3×30s · Hollow Body 3×25s`
          : `${s.note}\nSS1: Strict OHP ${s.u1} / ${pullupDesc}\nCORE: Pallof Press 3×10 · Suitcase Carry · Hollow Body`,
        dur: full ? 55 : 35,
      };
    },
    upperShort: (scheme = "acc2") => {
      const s = SCHEMES[scheme] || SCHEMES.acc2;
      return {
        type:"LIFT", title:"Upper A — Maintenance (40 min)",
        desc:`MAINTENANCE ONLY\nSS1: Bench Press ${s.u1} / Barbell Row ${s.u1}\nCORE: Dead Bug · Ab Wheel · McGill Curl-Up\nNo accessories — preserve legs for VO2.`,
        dur: 40,
      };
    },
    lowerA: (full = true, scheme = "acc") => {
      const s = SCHEMES[scheme] || SCHEMES.acc;
      return {
        type:"LIFT",
        title: full ? `Lower A — Squat (${scheme.toUpperCase()})` : "Lower A — Maintenance",
        desc: full
          ? `${s.note}\nSS1: Back Squat ${s.l1} / Romanian Deadlift ${s.l1}\nSS2: Bulgarian Split Squat ${s.l2} / Nordic Curl ${s.l2}\nCORE: Copenhagen Plank 3×25s · Side Plank+Abduction 3×12 · Bird Dog 3×8`
          : `MAINTENANCE — protect legs for cycling.\nSS1: Back Squat 2×5 heavy / Nordic Curl 2×5\nNo accessories.`,
        dur: full ? 55 : 30,
      };
    },
    lowerB: (full = true, scheme = "acc") => {
      const s = SCHEMES[scheme] || SCHEMES.acc;
      return {
        type:"LIFT",
        title: full ? `Lower B — Hinge (${scheme.toUpperCase()})` : "Lower B — Maintenance",
        desc: full
          ? `${s.note}\nSS1: Conventional Deadlift ${s.l1} / Bulgarian Split Squat ${s.l1}\nSS2: Good Morning ${s.l2} / Nordic Curl ${s.l2}\nCORE: Dead Bug+Band 3×8 · Prone Y-T-W 2×10 · Glute Bridge March 3×10`
          : `MAINTENANCE — protect legs for cycling.\nSS1: Conventional Deadlift 2×5 heavy / Nordic Curl 2×5\nNo accessories.`,
        dur: full ? 53 : 30,
      };
    },
    // Threshold/VO2 lower maintenance — Wednesday only, maximally distant from Tue/Fri
    lowerMaint: () => ({
      type:"LIFT", title:"Lower — Threshold Maintenance",
      desc:"MAINTENANCE — Wednesday only. Max distance from Tue/Fri quality sessions.\nSquat 2×5 heavy / Nordic Curl 2×5\nNo accessories. Keep it under 30 min.",
      dur: 28,
    }),
  };

  const rest = { type:"REST", title:"Rest", desc:"Full rest day.", dur:0 };

  // ── TRANSITION wks 1-2 ───────────────────────────────────────────────
  for (let w = 0; w < 2; w++) {
    weeks.push([
      [lift.upperA(true, "acc")],
      [lift.lowerA(true, "acc")],
      [rest],
      [lift.upperB(true, "acc")],
      [lift.lowerB(true, "acc")],
      [{ type:"FREE", title:"Unstructured ride", desc:"No zones, no targets. Ride for enjoyment only.", dur:60 }],
      [rest],
    ]);
  }

  // ── BASE wks 3-14 ────────────────────────────────────────────────────
  // Lifting periodization: W3–5 Accumulation · W7–9 Intensification · W11–13 Peak · W14 Deload/Retest
  const longDurs = [90,95,100,75,110,115,120,85,130,140,150,95];
  const recW = new Set([6, 10, 14]);

  for (let w = 0; w < 12; w++) {
    const gW = w + 3;
    const zw = zwW(gW);
    const ftp = getFtpForWeek(gW, checkpoints);
    const nA = w < 4 ? 4 : w < 8 ? 5 : 6;
    const ld = longDurs[w];
    // FIX: sprint targets dynamically from current FTP, 150–180%, 20s not 30s
    const spLo = Math.round(ftp * 1.50);
    const spHi = Math.round(ftp * 1.80);

    if (recW.has(gW)) {
      if (gW === 14) {
        // FIX: W14 is now a retest week
        weeks.push([
          [rest],
          [{ type:"Z2", title:"Easy Z2", desc:`Recovery. ${zw(56,75)}, HR <140.`, dur:50 }],
          [rest],
          [{ type:"Z2", title:"Easy Z2", desc:`Easy spin. ${zw(56,75)}.`, dur:45 }],
          [{ type:"Z4", title:"Openers — 3×1 min", desc:`3×1 min @ ${zw(106,115)}. Full rest between. Prime system for tomorrow's test.`, dur:30 }],
          [{ type:"TEST", title:"🔬 FTP RETEST — W14", desc:`20-min all-out effort. Fully rested and fuelled.\nAvg power × 0.95 = new FTP.\nEnter result in the retest banner above to update all Sweet Spot & Threshold zones.`, dur:60 }],
          [rest],
        ]);
      } else {
        weeks.push([
          [rest],
          [{ type:"Z2", title:"Z2 Easy", desc:`Recovery week. ${zw(56,75)}, HR <140 bpm.`, dur:50 }],
          [rest],
          [{ type:"Z2", title:"Z2 Easy", desc:`Easy Z2 spin. ${zw(56,75)}.`, dur:45 }],
          [rest],
          [{ type:"Z2", title:"Z2 Moderate Long", desc:`Moderate long ride. ${zw(56,75)}, HR <145.`, dur:80 }],
          [{ type:"FREE", title:"Weekend ride or rest", desc:"Uncontrolled ride or full rest.", dur:60 }],
        ]);
      }
    } else {
      const scheme = getLiftScheme(gW);
      weeks.push([
        [lift.upperA(true, scheme)],
        [{ type:"Z2", title:`Z2 + ${nA}×20s Sprints`,
           desc:`Z2 base ${zw(56,75)} + ${nA}×20s neuromuscular activations @ ${spLo}–${spHi}W.\nFull recovery between sprints (2–3 min easy). Shorter and harder than tempo surges — don't let them drift below ${spLo}W.`,
           dur:70 }],
        [lift.lowerA(true, scheme)],
        [lift.upperB(false, scheme), { type:"Z2", title:"Z2 Steady", desc:`Steady Z2. ${zw(56,75)}, HR <145 bpm.`, dur:50 }],
        [{ type:"Z2", title:"Z2 Steady", desc:`Z2 endurance. ${zw(56,75)}.`, dur:60 }],
        [{ type:"Z2", title:"Z2 Long Ride", desc:`Long Z2 build. ${zw(56,75)}, HR <145. Core base session.`, dur:ld }],
        [lift.lowerB(true, scheme), { type:"FREE", title:"Weekend ride", desc:"Uncontrolled fine. Hard surges are naturally polarized.", dur:75 }],
      ]);
    }
  }

  // ── SWEET SPOT wks 15-22 ─────────────────────────────────────────────
  // Lifting: acc2 (accumulation reset at heavier baseline) throughout
  // Lower body: full W15–18, maintenance W19–22
  const ssS = [
    ["3×10 min",65],["3×12 min",72],["2×20 min",82],["2×12 min",60],
    ["3×15 min",82],["3×18 min",90],["4×15 min",92],["2×15 min",68],
  ];
  const ssRec = new Set([18, 22]);

  for (let w = 0; w < 8; w++) {
    const gW = w + 15;
    const [sI, sD] = ssS[w];
    const zw = zwW(gW);
    const lowerFull = gW < 19; // FIX: maintenance from W19

    const ssSession = {
      type:"SS", title:`Sweet Spot ${sI}`,
      desc:`Sweet spot: ${sI} @ ${zw(88,93)}. 4–5 min rest. RPE 7–8.\nZones calculated from latest FTP retest.`,
      dur: sD,
    };

    if (ssRec.has(gW)) {
      if (gW === 22) {
        // FIX: W22 is now a retest week
        weeks.push([
          [rest],
          [{ type:"Z2", title:"Easy Z2", desc:`Recovery. ${zw(56,75)}.`, dur:50 }],
          [rest],
          [{ type:"Z2", title:"Easy Z2", desc:`Easy spin. ${zw(56,75)}.`, dur:45 }],
          [{ type:"Z4", title:"Openers — 3×1 min", desc:`3×1 min @ ${zw(106,115)}. Full rest. Prime for tomorrow's test.`, dur:30 }],
          [{ type:"TEST", title:"🔬 FTP RETEST — W22", desc:`20-min all-out effort.\nAvg power × 0.95 = new FTP.\nEnter result in the retest banner above to update all Threshold & VO2 zones.`, dur:60 }],
          [rest],
        ]);
      } else {
        // W18 regular recovery — lower body maintenance (combined with SS on same day)
        weeks.push([
          [rest],
          [{ type:"Z2", title:"Z2 Easy", desc:`Easy Z2 recovery. ${zw(56,75)}.`, dur:50 }],
          [lift.lowerA(false), ssSession],
          [rest],
          [lift.upperA(true)],
          [{ type:"SS", title:"SS Long 2×20 min", desc:`SS long: 2×20 min @ ${zw(88,93)}. 5 min rest.`, dur:88 }],
          [{ type:"FREE", title:"Weekend ride", desc:"Uncontrolled ride.", dur:75 }],
        ]);
      }
    } else {
      weeks.push([
        [lift.upperA(true, "acc2")],
        [{ type:"Z2", title:"Z2 Endurance", desc:`Z2 endurance. ${zw(56,75)}.`, dur:60 }],
        [lift.lowerA(lowerFull, lowerFull ? "acc2" : undefined)],
        [ssSession],
        [lift.upperB(false, "acc2"), { type:"Z2", title:"Z2 Endurance", desc:`Z2 endurance. ${zw(56,75)}.`, dur:50 }],
        [{ type:"SS", title:"SS Long 2×20 min", desc:`SS long: 2×20 min @ ${zw(88,93)}. 5 min rest.`, dur:88 }],
        [{ type:"FREE", title:"Weekend ride", desc:"Uncontrolled ride.", dur:75 }],
      ]);
    }
  }

  // ── THRESHOLD wks 23-30 ──────────────────────────────────────────────
  // Upper: acc2 scheme. Lower: maintenance on Wednesday only (max distance from Tue/Fri).
  // Sunday capped at Z2.
  const thS = [
    ["2×15 min",75,"3×(3+2)",80], ["3×12 min",80,"4×(3+2)",85],
    ["2×18 min",88,"4×(3+2)",88], ["2×12 min",65,"3×(3+2)",68],
    ["2×20 min",90,"5×(3+2)",92], ["3×15 min",90,"5×(3+2)",95],
    ["3×18 min",95,"6×(3+2)",100],["2×12 min",65,"3×(3+2)",68],
  ];
  const thRec = new Set([26, 30]);

  for (let w = 0; w < 8; w++) {
    const gW = w + 23;
    const [ti, td, oui, oud] = thS[w];
    const zw = zwW(gW);

    if (thRec.has(gW)) {
      if (gW === 30) {
        // FIX: W30 is now a retest week
        weeks.push([
          [lift.upperA(true, "acc2")],
          [{ type:"Z4", title:"Threshold Easy — 2×10 min", desc:`2×10 min @ ${zw(91,100)}. Recovery week — don't push.`, dur:55 }],
          [{ type:"Z2", title:"Z2 Recovery", desc:`Easy Z2. ${zw(56,75)}.`, dur:50 }],
          [lift.upperB(true, "acc2")],
          [{ type:"Z4", title:"Openers — 3×1 min", desc:`3×1 min @ ${zw(106,115)}. Full rest. Prime for tomorrow's test.`, dur:30 }],
          [{ type:"TEST", title:"🔬 FTP RETEST — W30", desc:`20-min all-out effort.\nAvg power × 0.95 = new FTP.\nEnter result in the retest banner above to update all VO2 zones.`, dur:60 }],
          [rest],
        ]);
      } else {
        // W26 regular recovery
        weeks.push([
          [lift.upperA(true, "acc2")],
          [{ type:"Z4", title:"Threshold Easy — 2×10 min", desc:`2×10 min @ ${zw(91,100)}. Recovery week.`, dur:55 }],
          [lift.lowerMaint(), { type:"Z2", title:"Z2 Recovery", desc:`Easy Z2. ${zw(56,75)}.`, dur:50 }],
          [lift.upperB(true, "acc2")],
          [rest],
          [{ type:"Z2", title:"Z2 Moderate", desc:`Moderate Z2 long. ${zw(56,75)}.`, dur:75 }],
          [{ type:"FREE", title:"Weekend ride — Z2 max", desc:`Z2 ceiling today — no group rides or racing. ${zw(56,75)}.\nPost-call? Rest instead.`, dur:75 }],
        ]);
      }
    } else {
      weeks.push([
        [lift.upperA(true, "acc2")],
        [{ type:"Z4", title:`Threshold ${ti}`, desc:`Threshold: ${ti} @ ${zw(91,105)}. 4–5 min rest. HR 166–184.`, dur:td }],
        // Lower body maintenance — Wednesday only, max distance from quality sessions
        [lift.lowerMaint(), { type:"Z2", title:"Z2 Recovery", desc:`Easy Z2 recovery. ${zw(56,75)}.`, dur:55 }],
        [lift.upperB(true, "acc2")],
        [{ type:"Z4", title:`Over-Unders ${oui}`, desc:`Over-unders: ${oui} sets.\nUnder: ${zw(91,95)} / Over: ${zw(100,105)}.`, dur:oud }],
        [{ type:"Z2", title:"Z2 Long", desc:`Long Z2. ${zw(56,75)}.`, dur:90 }],
        [{ type:"FREE", title:"Weekend ride — Z2 max", desc:`Z2 ceiling today — no group rides or racing. ${zw(56,75)}.\nPost-call? Rest instead.`, dur:75 }],
      ]);
    }
  }

  // ── VO2 wks 31-36 ───────────────────────────────────────────────────
  // Single VO2 session Tuesday. Lower body every 2 weeks (W31,33,35) on Wednesday.
  // Thursday: 1×20 threshold maintenance. Friday: Z2 only. Sunday: Z2 cap.
  const v2S = [
    ["5×4 min",75], ["5×5 min",80], ["4×5 min",75],
    ["5×5 min",80], ["4×6 min",80], ["3×5 min",65],
  ];

  for (let w = 0; w < 6; w++) {
    const gW = w + 31;
    const [v1, d1] = v2S[w];
    const zw = zwW(gW);
    const lowerThisWeek = (w % 2 === 0); // W31, W33, W35 get lower body
    weeks.push([
      [lift.upperShort()],
      [{ type:"Z5", title:`VO2 Max ${v1}`,
         desc:`VO2 Max: ${v1} @ ${zw(106,120)}. Equal rest between. HR 185–195 by final intervals.\nCan't finish? Rest more — don't drop power.`, dur:d1 }],
      // Lower body every 2 weeks on Wednesday
      lowerThisWeek
        ? [lift.lowerMaint(), { type:"Z2", title:"Z2 Recovery", desc:`Easy Z2. ${zw(56,75)}.`, dur:45 }]
        : [{ type:"Z2", title:"Z2 Recovery", desc:`Easy Z2 recovery. ${zw(56,75)}.`, dur:55 }],
      [{ type:"Z4", title:"Threshold Maintenance — 1×20 min",
         desc:`1×20 min @ ${zw(91,100)}. Single block — no repeats.\nKeep engine warm without stacking fatigue before next VO2 session.`, dur:50 }],
      [{ type:"Z2", title:"Z2 Endurance", desc:`Z2 endurance only. ${zw(56,75)}.\nNot a second VO2 session — allow full recovery for Tuesday.`, dur:60 }],
      [{ type:"Z2", title:"Z2 Long", desc:`Long Z2. ${zw(56,75)}.`, dur:85 }],
      [{ type:"FREE", title:"Weekend ride — Z2 max", desc:`Z2 ceiling today — no group rides or racing. ${zw(56,75)}.\nPost-call? Rest instead.`, dur:75 }],
    ]);
  }

  // ── TAPER wks 37-38 ─────────────────────────────────────────────────
  for (let w = 0; w < 2; w++) {
    const gW = w + 37;
    const zw = zwW(gW);
    if (w === 0) {
      weeks.push([
        [rest],
        [{ type:"Z2", title:"Easy Z2", desc:`Easy spin. ${zw(56,75)}. Legs should feel fresh.`, dur:45 }],
        [{ type:"Z1", title:"Active recovery", desc:"Very easy spin only.", dur:35 }],
        [{ type:"Z4", title:"Tune-Up — 2×8 min", desc:`2×8 min @ ${zw(91,105)}. Feel sharp — stop if stale.`, dur:50 }],
        [rest],
        [{ type:"Z2", title:"Easy spin", desc:`Light Z2. ${zw(56,75)}. Stay fresh.`, dur:40 }],
        [{ type:"FREE", title:"Easy ride or rest", desc:"Easy or rest.", dur:45 }],
      ]);
    } else {
      weeks.push([
        [rest],
        [{ type:"Z1", title:"Active recovery", desc:"Very easy legs-only spin.", dur:35 }],
        [rest],
        [{ type:"Z4", title:"Final sharpener — 2×6 min", desc:`2×6 min @ ${zw(91,105)}. Short and snappy.`, dur:38 }],
        [rest],
        [{ type:"TEST", title:"🏆 FTP RETEST — FINAL",
           desc:`20-min all-out effort. Fully rested and fuelled.\nAvg power × 0.95 = new FTP.\nTarget: 260–275W.`, dur:60 }],
        [rest],
      ]);
    }
  }

  return weeks;
}

// ── ICONS ─────────────────────────────────────────────────────────────────
const GCalIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{flexShrink:0}}>
    <rect x="3" y="4" width="18" height="17" rx="2" fill="white" stroke="#dadce0"/>
    <rect x="3" y="4" width="18" height="6" rx="2" fill="#4285f4"/>
    <rect x="3" y="8" width="18" height="2" fill="#4285f4"/>
    <text x="12" y="20" textAnchor="middle" fontSize="7" fontWeight="bold" fill="#1a73e8">
      {new Date().getDate()}
    </text>
    <rect x="8" y="2" width="2" height="4" rx="1" fill="#4285f4"/>
    <rect x="14" y="2" width="2" height="4" rx="1" fill="#4285f4"/>
  </svg>
);

const AppleIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{flexShrink:0}}>
    <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
  </svg>
);

// ── APP ───────────────────────────────────────────────────────────────────
export default function App() {
  const [sel, setSel]           = useState(0);
  const [saved, setSaved]       = useState({});
  const [expandDay, setExpandDay] = useState(null);
  const [dayMenu, setDayMenu]   = useState(null);
  const [flash, setFlash]       = useState(null);
  const [showProtocol, setShowProtocol] = useState(false);
  const [showFtpInput, setShowFtpInput] = useState(false);
  const [ftpDraft, setFtpDraft] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importDraft, setImportDraft] = useState("");
  const [icsLink, setIcsLink] = useState(null); // { url, name } — shown as tappable link

  // Load persisted data from localStorage on first render
  const [persisted]    = useState(() => lsLoad());
  const [checkpoints, setCheckpoints] = useState(
    () => persisted.checkpoints || [BASE_FTP, null, null, null]
  );
  const [compliance, setCompliance] = useState(
    () => persisted.compliance || {}
  );
  // Custom week start dates — allows redoing or pushing weeks forward
  const [weekDates, setWeekDates] = useState(
    () => persisted.weekDates || {}
  );
  const [editingWeekDate, setEditingWeekDate] = useState(false);

  const wn    = sel + 1;
  const phase = getPhase(wn);

  // FIX: Plan rebuilds whenever FTP checkpoints change
  const PLAN  = useMemo(() => buildPlan(checkpoints), [checkpoints]);
  const week  = PLAN[sel];

  const currentFtp  = getFtpForWeek(wn, checkpoints);
  const isRetestWeek = RETEST_WEEKS.has(wn);
  const retestIdx   = wn === 14 ? 1 : wn === 22 ? 2 : wn === 30 ? 3 : -1;
  const retestDone  = retestIdx > 0 && checkpoints[retestIdx] != null;
  const prevFtp     = retestIdx > 0 ? (checkpoints[retestIdx - 1] ?? BASE_FTP) : null;

  const wS = getDateForDay(sel, 0, weekDates);
  const wE = getDateForDay(sel, 6, weekDates);

  const toast = (msg, type = "ok") => {
    setFlash({ msg, type });
    setTimeout(() => setFlash(null), 4000);
  };

  const submitFtp = () => {
    const v = parseInt(ftpDraft);
    if (!v || v < 150 || v > 450) { toast("Enter a valid FTP (150–450W)", "err"); return; }
    const newCps = [...checkpoints]; newCps[retestIdx] = v;
    setCheckpoints(newCps);
    lsSave({ checkpoints: newCps, compliance, weekDates });
    setFtpDraft("");
    setShowFtpInput(false);
    toast(`FTP updated to ${v}W — all future zones recalculated`);
  };

  // Update a week's start date
  const setWeekStartDate = useCallback((wi, isoDate) => {
    const next = { ...weekDates, [wi]: isoDate };
    setWeekDates(next);
    lsSave({ checkpoints, compliance, weekDates: next });
    setEditingWeekDate(false);
    toast(`Week ${wi+1} start date updated`);
  }, [checkpoints, compliance, weekDates]);

  // Cycle compliance status for a session
  const cycleCompliance = useCallback((wi, di, si, e) => {
    e.stopPropagation();
    setCompliance(prev => {
      const key = compKey(wi, di, si);
      const next = { ...prev, [key]: nextStatus(prev[key] ?? null) };
      if (next[key] === null) delete next[key];
      lsSave({ checkpoints, compliance: next, weekDates });
      return next;
    });
  }, [checkpoints, weekDates]);

  // Export all data as JSON download
  const exportData = useCallback(() => {
    const data = { checkpoints, compliance, weekDates, exportedAt: new Date().toISOString(), version: 2 };
    const b = new Blob([JSON.stringify(data, null, 2)], { type:"application/json" });
    const u = URL.createObjectURL(b);
    const a = document.createElement("a"); a.href = u;
    a.download = `training-plan-data-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(u);
    toast("Data exported — import this file on any device to restore");
  }, [checkpoints, compliance, weekDates]);

  // Import data from JSON
  const importData = useCallback(() => {
    try {
      const data = JSON.parse(importDraft);
      if (!data.checkpoints || !Array.isArray(data.checkpoints)) throw new Error("Invalid format");
      setCheckpoints(data.checkpoints);
      setCompliance(data.compliance || {});
      setWeekDates(data.weekDates || {});
      lsSave({ checkpoints: data.checkpoints, compliance: data.compliance || {}, weekDates: data.weekDates || {} });
      setImportDraft("");
      setShowImport(false);
      toast("Data imported — all compliance, FTP checkpoints and dates restored");
    } catch { toast("Invalid JSON — paste the full exported file contents", "err"); }
  }, [importDraft]);

  function makeEv(sess, di) {
    const date = getDateForDay(sel, di, weekDates);
    return {
      date,
      title: `${sess.type==="LIFT"?"🏋️":sess.type==="Z5"?"⚡":sess.type==="Z4"?"🔥":sess.type==="SS"?"🔶":sess.type==="TEST"?"🔬":"🚴"} ${sess.title} [W${wn}·${DAY_NAMES[di]}]`,
      desc:  sess.desc + `\n\nPhase: ${phase.name} | Duration: ${sess.dur} min | FTP: ${currentFtp}W`,
      dur:   sess.dur,
      phase: phase.name,
      ftp:   currentFtp,
    };
  }

  const openGCal = useCallback((di, si) => {
    const sess = week[di][si];
    if (!sess.dur) return;
    window.open(gcalUrl(makeEv(sess, di)), "_blank");
    setSaved(p => ({ ...p, [`${sel}-${di}-${si}`]: true }));
    setDayMenu(null);
    toast("Opening Google Calendar — click Save ✓");
  }, [sel, week, wn, phase, currentFtp]);

  const dlDayICS = useCallback((di, si) => {
    const sess = week[di][si];
    if (!sess.dur) return;
    const name = `training_W${wn}_${DAY_NAMES[di]}_${sess.type}.ics`;
    if (icsLink?.blob) URL.revokeObjectURL(icsLink.url);
    setIcsLink(makeICSLink(buildICS([makeEv(sess, di)]), name));
    setSaved(p => ({ ...p, [`${sel}-${di}-${si}`]: true }));
    setDayMenu(null);
    toast("iCal ready — tap the banner to open in Calendar");
  }, [sel, week, wn, phase, currentFtp, icsLink]);

  const pushWeekGCal = useCallback(() => {
    const evs = [];
    week.forEach((sessions, di) => sessions.forEach((s, si) => { if (s.dur) evs.push({ ev: makeEv(s, di), di, si }); }));
    if (!evs.length) { toast("No active sessions", "err"); return; }
    evs.forEach(({ ev }, i) => setTimeout(() => window.open(gcalUrl(ev), "_blank"), i * 450));
    const k = {};
    week.forEach((ss, di) => ss.forEach((_, si) => { if (week[di][si].dur) k[`${sel}-${di}-${si}`] = true; }));
    setSaved(p => ({ ...p, ...k }));
    toast(`Opening ${evs.length} Google Calendar tabs — save each`);
  }, [sel, week, wn, phase, currentFtp]);

  const pushWeekICS = useCallback(() => {
    const evs = [];
    week.forEach((sessions, di) => sessions.forEach((s, si) => { if (s.dur) evs.push(makeEv(s, di)); }));
    if (!evs.length) { toast("No active sessions", "err"); return; }
    if (icsLink?.blob) URL.revokeObjectURL(icsLink.url);
    setIcsLink(makeICSLink(buildICS(evs), `training_W${wn}_full_week.ics`));
    const k = {};
    week.forEach((ss, di) => ss.forEach((_, si) => { if (week[di][si].dur) k[`${sel}-${di}-${si}`] = true; }));
    setSaved(p => ({ ...p, ...k }));
    toast(`W${wn} iCal ready — tap the banner to open in Calendar`);
  }, [sel, week, wn, phase, currentFtp, icsLink]);

  const activeSessions = week.reduce((a, ss) => a + ss.filter(s => s.dur > 0).length, 0);
  const savedCount     = week.reduce((a, ss, di) => a + ss.filter((_, si) => saved[`${sel}-${di}-${si}`]).length, 0);
  const totalMin       = week.reduce((a, ss) => a + ss.reduce((b, s) => b + s.dur, 0), 0);
  const doneByMax      = week.slice(0, 5).reduce((max, ss) => Math.max(max, ss.reduce((a, s) => a + s.dur, 0)), 0);
  const doneByTime     = doneByMax ? fmtEndTime(doneByMax) : "—";
  const wComp          = weekCompliance(PLAN, sel, compliance);
  const compColor      = wComp.logged === 0 ? "#334155"
    : wComp.skipped > wComp.done + wComp.modified ? "#F87171"
    : wComp.logged === wComp.total ? "#34D399" : "#F97316";

  return (
    <div onClick={() => setDayMenu(null)}
      style={{ background:"#060910", minHeight:"100vh",
        fontFamily:"'SF Mono','JetBrains Mono','Fira Code',monospace",
        color:"#CBD5E1", paddingBottom:48 }}>

      {/* ── IMPORT MODAL ── */}
      {showImport && (
        <div onClick={() => setShowImport(false)}
          style={{ position:"fixed", inset:0, background:"#000000CC", zIndex:500,
            display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:"#0D1424", border:"1px solid #1E293B", borderRadius:10,
              maxWidth:420, width:"100%", padding:20 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
              <span style={{ fontSize:12, fontWeight:700, color:"#F8FAFC", letterSpacing:1 }}>IMPORT DATA</span>
              <button onClick={() => setShowImport(false)}
                style={{ background:"transparent", border:"none", color:"#475569", cursor:"pointer", fontSize:18 }}>✕</button>
            </div>
            <div style={{ fontSize:9, color:"#475569", marginBottom:8, lineHeight:1.6 }}>
              Paste the contents of your exported JSON file below. This will overwrite all current compliance data and FTP checkpoints.
            </div>
            <textarea value={importDraft} onChange={e => setImportDraft(e.target.value)}
              placeholder='{"checkpoints":[238,null,null,null],"compliance":{...}}'
              style={{ width:"100%", height:120, background:"#080C14", border:"1px solid #1E293B",
                borderRadius:6, color:"#CBD5E1", fontSize:9, fontFamily:"inherit",
                padding:"8px", resize:"vertical", boxSizing:"border-box" }}/>
            <div style={{ display:"flex", gap:8, marginTop:10 }}>
              <button onClick={importData}
                style={{ flex:1, padding:"7px", background:"#0D9488", color:"white",
                  border:"none", borderRadius:5, cursor:"pointer", fontSize:10, fontWeight:700 }}>
                IMPORT
              </button>
              <button onClick={() => { setShowImport(false); setImportDraft(""); }}
                style={{ padding:"7px 14px", background:"transparent", color:"#475569",
                  border:"1px solid #1E293B", borderRadius:5, cursor:"pointer", fontSize:10 }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── DISRUPTION PROTOCOL MODAL ── */}
      {showProtocol && (
        <div onClick={() => setShowProtocol(false)}
          style={{ position:"fixed", inset:0, background:"#000000CC", zIndex:500,
            display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:"#0D1424", border:"1px solid #1E293B", borderRadius:10,
              maxWidth:460, width:"100%", maxHeight:"80vh", overflowY:"auto", padding:20 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
              <span style={{ fontSize:12, fontWeight:700, color:"#F8FAFC", letterSpacing:1 }}>
                ⚡ DISRUPTION PROTOCOL
              </span>
              <button onClick={() => setShowProtocol(false)}
                style={{ background:"transparent", border:"none", color:"#475569", cursor:"pointer", fontSize:18 }}>✕</button>
            </div>
            {DISRUPTION_PROTOCOL.map((item, i) => (
              <div key={i} style={{ marginBottom:10, padding:"10px 12px",
                background:"#080C14", border:"1px solid #1E293B", borderRadius:6 }}>
                <div style={{ fontSize:9.5, fontWeight:700, color:"#F97316", marginBottom:4, letterSpacing:0.5 }}>
                  {item.q}
                </div>
                <div style={{ fontSize:9.5, color:"#64748B", lineHeight:1.65 }}>{item.a}</div>
              </div>
            ))}
            <div style={{ marginTop:12, padding:"9px 12px",
              background:"#0A1929", border:"1px solid #1E3A5F", borderRadius:6 }}>
              <div style={{ fontSize:9, color:"#3B82F6", lineHeight:1.7 }}>
                <b>Remember:</b> A plan that survives real life is worth more than a perfect plan on paper.
                Adapt, don't abandon.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── HEADER ── */}
      <div style={{ background:`linear-gradient(160deg,${phase.bg},#060910)`,
        borderBottom:`1px solid ${phase.color}33`, padding:"16px 16px 12px" }}>

        {/* Title + phase pills */}
        <div style={{ display:"flex", justifyContent:"space-between",
          alignItems:"center", flexWrap:"wrap", gap:8, marginBottom:12 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:22 }}>🚴🏋️</span>
            <div>
              <div style={{ fontSize:14, fontWeight:700, letterSpacing:2, color:"#F8FAFC" }}>
                COMPLETE TRAINING PLAN v2
              </div>
              <div style={{ fontSize:8.5, color:"#475569", letterSpacing:1, marginTop:1 }}>
                CYCLING · STRENGTH · CORE &nbsp;·&nbsp; BASE {BASE_FTP}W → CURRENT {currentFtp}W &nbsp;·&nbsp; MAY 2026 – FEB 2027
              </div>
            </div>
          </div>
          <div style={{ display:"flex", gap:5, flexWrap:"wrap", alignItems:"center" }}>
            <button onClick={e => { e.stopPropagation(); setShowProtocol(true); }}
              style={{ padding:"4px 10px", border:"1px solid #F9731655", borderRadius:4,
                cursor:"pointer", fontSize:8, fontWeight:700, letterSpacing:0.8,
                background:"#F9731611", color:"#F97316" }}>
              ⚡ PROTOCOL
            </button>
            <button onClick={exportData}
              style={{ padding:"4px 10px", border:"1px solid #0D948855", borderRadius:4,
                cursor:"pointer", fontSize:8, fontWeight:700, letterSpacing:0.8,
                background:"#0D948811", color:"#0D9488" }}>
              ↓ EXPORT
            </button>
            <button onClick={e => { e.stopPropagation(); setShowImport(true); }}
              style={{ padding:"4px 10px", border:"1px solid #3B82F655", borderRadius:4,
                cursor:"pointer", fontSize:8, fontWeight:700, letterSpacing:0.8,
                background:"#3B82F611", color:"#3B82F6" }}>
              ↑ IMPORT
            </button>
            {PHASES.map(ph => {
              const active = wn >= ph.weeks[0] && wn <= ph.weeks[1];
              const pct = phaseCompliance(PLAN, ph, compliance);
              return (
                <button key={ph.id}
                  onClick={() => { setSel(ph.weeks[0]-1); setExpandDay(null); setDayMenu(null); }}
                  style={{ padding:"3px 8px", border:`1px solid ${active ? ph.color : "#1E293B"}`,
                    borderRadius:4, cursor:"pointer", fontSize:8, fontWeight:700, letterSpacing:0.8,
                    background: active ? ph.color+"22" : "transparent",
                    color: active ? ph.color : "#334155" }}>
                  {ph.name.toUpperCase()}
                  {pct !== null && <span style={{ marginLeft:4, fontSize:7, opacity:0.7 }}>{pct}%</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* FIX: FTP Retest Banner — appears on W14, W22, W30 */}
        {isRetestWeek && (
          <div style={{ marginBottom:10, padding:"10px 14px",
            background: retestDone ? "#0F2918" : "#1A0800",
            border:`1px solid ${retestDone ? "#166534" : "#F9731688"}`, borderRadius:7 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:8 }}>
              <div>
                <div style={{ fontSize:10, fontWeight:700, color: retestDone ? "#34D399" : "#F97316", marginBottom:2 }}>
                  {retestDone
                    ? `✓ RETEST COMPLETE — New FTP: ${checkpoints[retestIdx]}W (+${checkpoints[retestIdx] - prevFtp}W)`
                    : `🔬 FTP RETEST WEEK — W${wn}`}
                </div>
                <div style={{ fontSize:8.5, color:"#475569" }}>
                  {retestDone
                    ? `All zones from W${wn+1} onward updated. Previous FTP: ${prevFtp}W`
                    : `Complete Saturday's test, then enter your result here to auto-update all future zones. Previous FTP: ${prevFtp}W`}
                </div>
              </div>
              {!retestDone && (
                <div style={{ display:"flex", gap:6, alignItems:"center" }} onClick={e => e.stopPropagation()}>
                  {showFtpInput ? (
                    <>
                      <input type="number" placeholder="e.g. 248" value={ftpDraft}
                        onChange={e => setFtpDraft(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && submitFtp()}
                        style={{ width:80, padding:"4px 8px", background:"#0D1424",
                          border:`1px solid #F97316`, borderRadius:4,
                          color:"#F8FAFC", fontSize:11, fontFamily:"inherit" }}/>
                      <button onClick={submitFtp}
                        style={{ padding:"4px 10px", background:"#F97316", color:"white",
                          border:"none", borderRadius:4, cursor:"pointer", fontSize:9, fontWeight:700 }}>
                        SAVE
                      </button>
                      <button onClick={() => { setShowFtpInput(false); setFtpDraft(""); }}
                        style={{ padding:"4px 8px", background:"transparent", color:"#475569",
                          border:"1px solid #1E293B", borderRadius:4, cursor:"pointer", fontSize:9 }}>
                        ✕
                      </button>
                    </>
                  ) : (
                    <button onClick={() => setShowFtpInput(true)}
                      style={{ padding:"5px 12px", background:"#F97316", color:"white",
                        border:"none", borderRadius:4, cursor:"pointer", fontSize:9, fontWeight:700 }}>
                      ENTER RESULT
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* FTP checkpoint progress pills */}
        <div style={{ display:"flex", gap:6, marginBottom:10, flexWrap:"wrap" }}>
          {[
            { label:"Base", ftp:checkpoints[0], wk:"Start" },
            { label:"Post-Base", ftp:checkpoints[1], wk:"W14" },
            { label:"Post-SS", ftp:checkpoints[2], wk:"W22" },
            { label:"Post-Thresh", ftp:checkpoints[3], wk:"W30" },
          ].map((cp, i) => (
            <div key={i} style={{ padding:"3px 9px", borderRadius:4, fontSize:8,
              background: cp.ftp ? "#0F2918" : "#0D1424",
              border:`1px solid ${cp.ftp ? "#166534" : "#1E293B"}`,
              color: cp.ftp ? "#34D399" : "#334155" }}>
              {cp.wk}: <b>{cp.ftp ? `${cp.ftp}W` : "—"}</b>
              {i > 0 && cp.ftp && checkpoints[i-1]
                ? <span style={{ color:"#22c55e", marginLeft:4 }}>+{cp.ftp - (checkpoints[i-1] ?? BASE_FTP)}W</span>
                : null}
            </div>
          ))}
        </div>

        {/* Week nav bar */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
          background:"#0B1120", border:`1px solid ${phase.color}44`,
          borderRadius:8, padding:"10px 14px", flexWrap:"wrap", gap:10 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <button onClick={() => { setSel(Math.max(0,sel-1)); setExpandDay(null); setDayMenu(null); setEditingWeekDate(false); }}
              disabled={sel===0}
              style={{ background:"transparent", border:`1px solid ${phase.color}88`, color:phase.color,
                borderRadius:4, width:26, height:26, cursor:"pointer", fontSize:13, fontWeight:700,
                opacity:sel===0?0.3:1 }}>‹</button>
            <div>
              <div style={{ display:"flex", alignItems:"baseline", gap:6 }}>
                <span style={{ fontSize:20, fontWeight:700, color:phase.color }}>W{wn}</span>
                <span style={{ fontSize:9, color:"#334155" }}>/ 38</span>
              </div>
              {editingWeekDate ? (
                <div style={{ display:"flex", gap:4, alignItems:"center", marginTop:2 }}
                  onClick={e => e.stopPropagation()}>
                  <input type="date"
                    defaultValue={toISODate(wS)}
                    onChange={e => e.target.value && setWeekStartDate(sel, e.target.value)}
                    style={{ fontSize:9, background:"#0D1424", border:`1px solid ${phase.color}`,
                      borderRadius:4, color:"#F8FAFC", padding:"2px 4px", fontFamily:"inherit" }}/>
                  <button onClick={() => setEditingWeekDate(false)}
                    style={{ background:"transparent", border:"none", color:"#475569",
                      cursor:"pointer", fontSize:13 }}>✕</button>
                </div>
              ) : (
                <div onClick={e => { e.stopPropagation(); setEditingWeekDate(true); }}
                  style={{ fontSize:8.5, color:"#475569", cursor:"pointer",
                    borderBottom:"1px dashed #1E293B", display:"inline-block" }}>
                  {fmtDate(wS)} – {fmtDate(wE)}{weekDates[sel] ? " ✎" : ""}
                </div>
              )}
            </div>
            <button onClick={() => { setSel(Math.min(37,sel+1)); setExpandDay(null); setDayMenu(null); setEditingWeekDate(false); }}
              disabled={sel===37}
              style={{ background:"transparent", border:`1px solid ${phase.color}88`, color:phase.color,
                borderRadius:4, width:26, height:26, cursor:"pointer", fontSize:13, fontWeight:700,
                opacity:sel===37?0.3:1 }}>›</button>

            <div style={{ borderLeft:"1px solid #1E293B", paddingLeft:10, display:"flex", flexDirection:"column", gap:1 }}>
              <span style={{ fontSize:8, fontWeight:700, color:phase.color, letterSpacing:1 }}>
                {phase.name.toUpperCase()}
              </span>
              <span style={{ fontSize:8, color:"#334155" }}>
                Wk {wn-phase.weeks[0]+1} of {phase.weeks[1]-phase.weeks[0]+1}
              </span>
            </div>

            <div style={{ borderLeft:"1px solid #1E293B", paddingLeft:10, display:"flex", flexDirection:"column", gap:1 }}>
              <span style={{ fontSize:8, color:"#475569" }}>
                ⚡ <b style={{ color:"#94A3B8" }}>{activeSessions}</b> sessions &nbsp;·&nbsp;
                ⏱ <b style={{ color:"#94A3B8" }}>{totalMin}</b> min
              </span>
              <span style={{ fontSize:8, color:"#475569" }}>
                compliance: <b style={{ color:compColor }}>
                  {wComp.logged === 0 ? "not started"
                    : `${wComp.done}✓ ${wComp.modified > 0 ? wComp.modified+"~ " : ""}${wComp.skipped > 0 ? wComp.skipped+"✗ " : ""}/ ${wComp.total}`}
                </b>
                &nbsp;·&nbsp; 🕐 <b style={{ color: doneByTime>="6:00"?"#F87171":"#34D399" }}>{doneByTime}</b>
              </span>
            </div>
          </div>

          <div style={{ display:"flex", gap:7, flexWrap:"wrap" }}>
            <button onClick={pushWeekGCal}
              style={{ display:"flex", alignItems:"center", gap:5, padding:"6px 12px",
                background:"#1a73e8", color:"white", border:"none", borderRadius:5,
                cursor:"pointer", fontSize:9.5, fontWeight:700, letterSpacing:0.3,
                boxShadow:"0 0 12px #1a73e844" }}>
              <GCalIcon/> WEEK → GOOGLE
            </button>
            <button onClick={pushWeekICS}
              style={{ display:"flex", alignItems:"center", gap:5, padding:"6px 12px",
                background:phase.color, color:"white", border:"none", borderRadius:5,
                cursor:"pointer", fontSize:9.5, fontWeight:700, letterSpacing:0.3,
                boxShadow:`0 0 12px ${phase.color}44` }}>
              <AppleIcon/> WEEK → iCAL
            </button>
          </div>
        </div>
      </div>

      {/* ── FLASH ── */}
      {flash && (
        <div style={{ margin:"8px 16px 0", padding:"8px 12px", borderRadius:6, fontSize:10.5,
          background: flash.type==="ok"?"#0F2918":"#2D0A0A",
          border:`1px solid ${flash.type==="ok"?"#166534":"#7F1D1D"}`,
          color: flash.type==="ok"?"#34D399":"#F87171" }}>
          {flash.msg}
        </div>
      )}

      {/* ── iCAL DOWNLOAD BANNER ── */}
      {icsLink && (
        <div style={{ margin:"8px 16px 0", padding:"10px 14px", borderRadius:6,
          background:"#0C1E35", border:"1px solid #3B82F677",
          display:"flex", justifyContent:"space-between", alignItems:"center", gap:12 }}>
          <div style={{ fontSize:9.5, color:"#60A5FA", lineHeight:1.5 }}>
            <b>iCal ready.</b> Tap the button to open in Calendar.
            <div style={{ fontSize:8.5, color:"#334155", marginTop:2 }}>
              iPhone: tap Open → Add All to Calendar
            </div>
          </div>
          <div style={{ display:"flex", gap:8, flexShrink:0 }}>
            <a href={icsLink.url} download={icsLink.name}
              onClick={() => setTimeout(() => {
                if (icsLink?.blob) URL.revokeObjectURL(icsLink.url);
                setIcsLink(null);
              }, 2000)}
              style={{ display:"flex", alignItems:"center", gap:5,
                padding:"7px 14px", background:"#3B82F6", color:"white",
                borderRadius:5, fontSize:10, fontWeight:700,
                textDecoration:"none", border:"none" }}>
              <AppleIcon/> OPEN
            </a>
            <button onClick={() => {
              if (icsLink?.blob) URL.revokeObjectURL(icsLink.url);
              setIcsLink(null);
            }}
              style={{ background:"transparent", border:"1px solid #1E293B",
                color:"#475569", borderRadius:5, padding:"7px 10px",
                cursor:"pointer", fontSize:10 }}>✕</button>
          </div>
        </div>
      )}

      {/* ── DAY CARDS ── */}
      <div style={{ padding:"12px 16px 0", display:"flex", flexDirection:"column", gap:6 }}>
        {week.map((sessions, di) => {
          const date        = getDateForDay(sel, di, weekDates);
          const isExpanded  = expandDay === di;
          const totalDayMin = sessions.reduce((a, s) => a + s.dur, 0);
          const endTime     = totalDayMin ? fmtEndTime(totalDayMin) : null;
          const isRest      = sessions.every(s => s.dur === 0);
          const allSaved    = sessions.filter(s => s.dur > 0).every((_, si) => saved[`${sel}-${di}-${si}`]);
          // Compliance indicator for collapsed view
          const daySessions = sessions.filter(s => s.dur > 0);
          const dayStatuses = daySessions.map((_, si) => compliance[compKey(sel, di, si)] ?? null);
          const dayDone     = dayStatuses.filter(s => s === "done").length;
          const dayMod      = dayStatuses.filter(s => s === "modified").length;
          const daySkip     = dayStatuses.filter(s => s === "skipped").length;
          const dayLogged   = dayDone + dayMod + daySkip;
          const dayCompColor = dayLogged === 0 ? null
            : daySkip > 0 && dayDone + dayMod === 0 ? "#F87171"
            : dayLogged === daySessions.length && daySkip === 0 ? "#34D399"
            : "#F97316";

          return (
            <div key={di} style={{ position:"relative" }}>
              <div onClick={() => !isRest && setExpandDay(isExpanded ? null : di)}
                style={{
                  background: isRest ? "#080C14" : "#0D1424",
                  border:`1px solid ${isRest?"#111827":allSaved?"#166534":phase.color+"33"}`,
                  borderRadius:8, overflow:"hidden",
                  cursor: isRest ? "default" : "pointer",
                  opacity: isRest ? 0.4 : 1,
                }}>

                {/* Day header row */}
                <div style={{ display:"flex", alignItems:"center",
                  padding:"9px 12px",
                  borderBottom: isExpanded&&!isRest ? `1px solid ${phase.color}22` : "none" }}>

                  <div style={{ width:40, flexShrink:0, marginRight:10 }}>
                    <div style={{ fontSize:9, fontWeight:700, color:"#334155", letterSpacing:1 }}>
                      {DAY_NAMES[di]}
                    </div>
                    <div style={{ fontSize:8, color:"#1E293B", marginTop:1 }}>
                      {fmtDate(date, { month:"numeric", day:"numeric" })}
                    </div>
                    {dayCompColor && (
                      <div style={{ marginTop:2, width:8, height:8, borderRadius:"50%",
                        background:dayCompColor }} />
                    )}
                  </div>

                  <div style={{ display:"flex", gap:4, marginRight:10, flexShrink:0 }}>
                    {sessions.map((s, si) => {
                      const tc = TYPE[s.type] || TYPE.REST;
                      return s.dur > 0 ? (
                        <div key={si} style={{ display:"flex", alignItems:"center", gap:3,
                          padding:"2px 6px", borderRadius:4,
                          background:tc.bg, border:`1px solid ${tc.color}55`, fontSize:9 }}>
                          <span>{tc.icon}</span>
                          <span style={{ color:tc.color, fontWeight:700 }}>{tc.label}</span>
                        </div>
                      ) : null;
                    })}
                    {isRest && (
                      <div style={{ display:"flex", alignItems:"center", gap:3,
                        padding:"2px 6px", borderRadius:4,
                        background:"#0F172A", border:"1px solid #1E293B", fontSize:9 }}>
                        <span>🌙</span>
                        <span style={{ color:"#334155", fontWeight:700 }}>REST</span>
                      </div>
                    )}
                  </div>

                  <div style={{ flex:1, minWidth:0 }}>
                    {isRest ? (
                      <span style={{ fontSize:10, color:"#1E293B" }}>Rest day</span>
                    ) : (
                      sessions.filter(s => s.dur > 0).map((s, si) => (
                        <div key={si} style={{ fontSize:10, fontWeight: si===0?700:500,
                          color: si===0?"#94A3B8":"#475569",
                          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                          {s.title}
                        </div>
                      ))
                    )}
                  </div>

                  {endTime && (
                    <div style={{ marginRight:10, textAlign:"right", flexShrink:0 }}>
                      <div style={{ fontSize:8, color:"#334155" }}>4:30 AM</div>
                      <div style={{ fontSize:9.5, fontWeight:700,
                        color: endTime>="6:00"?"#F87171":"#34D399" }}>→ {endTime}</div>
                      <div style={{ fontSize:7.5, color:"#1E293B" }}>{totalDayMin} min</div>
                    </div>
                  )}

                  {!isRest && (
                    <div style={{ flexShrink:0 }} onClick={e => e.stopPropagation()}>
                      {allSaved ? (
                        <div style={{ padding:"4px 9px", borderRadius:5,
                          background:"#0F2918", border:"1px solid #166534",
                          fontSize:9, color:"#34D399", fontWeight:700 }}>✓ SAVED</div>
                      ) : (
                        <button
                          onClick={e => { e.stopPropagation();
                            setDayMenu(dayMenu?.day===di ? null : { day:di, mode:"day" }); }}
                          style={{ display:"flex", alignItems:"center", gap:4,
                            padding:"5px 10px", borderRadius:5,
                            border:`1px solid ${phase.color}77`,
                            background: phase.color+"22", color:phase.color,
                            cursor:"pointer", fontSize:9, fontWeight:700 }}>
                          ADD ▾
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Expanded detail */}
                {isExpanded && !isRest && (
                  <div style={{ padding:"10px 12px", display:"flex", flexDirection:"column", gap:8 }}>
                    {sessions.filter(s => s.dur > 0).map((s, si) => {
                      const tc = TYPE[s.type] || TYPE.REST;
                      const isSaved  = saved[`${sel}-${di}-${si}`];
                      const menuOpen = dayMenu?.day===di && dayMenu?.si===si;
                      const compSt   = compliance[compKey(sel, di, si)] ?? null;
                      const cui      = STATUS_UI[compSt];
                      return (
                        <div key={si} style={{
                          background:tc.bg, border:`1px solid ${tc.color}44`,
                          borderRadius:6, padding:"8px 10px" }}>
                          <div style={{ display:"flex", justifyContent:"space-between",
                            alignItems:"flex-start", gap:8 }}>
                            <div style={{ flex:1, minWidth:0 }}>
                              <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:5 }}>
                                <span style={{ fontSize:14 }}>{tc.icon}</span>
                                <span style={{ fontSize:11, fontWeight:700, color:tc.color }}>{s.title}</span>
                                <span style={{ fontSize:9, color:"#334155",
                                  padding:"1px 5px", borderRadius:3,
                                  background:tc.color+"22", border:`1px solid ${tc.color}44` }}>
                                  {s.dur} min
                                </span>
                              </div>
                              <div style={{ fontSize:9.5, color:"#64748B", lineHeight:1.65, whiteSpace:"pre-line" }}>
                                {s.desc}
                              </div>
                            </div>
                            {/* Right side: compliance toggle + calendar add */}
                            <div style={{ flexShrink:0, display:"flex", flexDirection:"column", gap:5, alignItems:"flex-end" }}
                              onClick={e => e.stopPropagation()}>
                              {/* Compliance toggle */}
                              <button
                                onClick={e => cycleCompliance(sel, di, si, e)}
                                title="Tap to cycle: not logged → done ✓ → modified ~ → skipped ✗"
                                style={{ padding:"4px 10px", borderRadius:5, cursor:"pointer",
                                  border:`1px solid ${cui.border}`,
                                  background:cui.bg, color:cui.color,
                                  fontSize:11, fontWeight:700, minWidth:32 }}>
                                {cui.label}
                              </button>
                              {/* Calendar add */}
                              {isSaved ? (
                                <div style={{ padding:"3px 7px", borderRadius:5,
                                  background:"#0F2918", border:"1px solid #166534",
                                  fontSize:8, color:"#34D399", fontWeight:700 }}>CAL ✓</div>
                              ) : (
                                <>
                                  <button
                                    onClick={e => { e.stopPropagation();
                                      setDayMenu(menuOpen ? null : { day:di, si, mode:"sess" }); }}
                                    style={{ padding:"4px 8px", borderRadius:5,
                                      border:`1px solid ${tc.color}77`,
                                      background:tc.color+"22", color:tc.color,
                                      cursor:"pointer", fontSize:8, fontWeight:700 }}>
                                    ADD ▾
                                  </button>
                                  {menuOpen && (
                                    <div style={{ position:"absolute", right:0, top:"calc(100% + 4px)",
                                      background:"#111827", border:"1px solid #1E293B",
                                      borderRadius:7, overflow:"hidden", zIndex:200,
                                      boxShadow:"0 8px 24px #00000099", minWidth:190 }}>
                                      <button onClick={e => { e.stopPropagation(); openGCal(di,si); }}
                                        style={{ display:"flex", alignItems:"center", gap:8,
                                          width:"100%", padding:"9px 13px", background:"transparent",
                                          border:"none", borderBottom:"1px solid #1E293B",
                                          color:"#E2E8F0", cursor:"pointer", fontSize:10.5,
                                          fontWeight:600, textAlign:"left" }}>
                                        <GCalIcon/> Google Calendar
                                      </button>
                                      <button onClick={e => { e.stopPropagation(); dlDayICS(di,si); }}
                                        style={{ display:"flex", alignItems:"center", gap:8,
                                          width:"100%", padding:"9px 13px", background:"transparent",
                                          border:"none", color:"#E2E8F0", cursor:"pointer",
                                          fontSize:10.5, fontWeight:600, textAlign:"left" }}>
                                        <AppleIcon/> Download .ics
                                      </button>
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Day-level ADD dropdown */}
              {dayMenu?.day===di && dayMenu?.mode==="day" && (
                <div onClick={e => e.stopPropagation()}
                  style={{ position:"absolute", right:0, top:"calc(100% + 4px)",
                    background:"#111827", border:"1px solid #1E293B",
                    borderRadius:7, overflow:"hidden", zIndex:200,
                    boxShadow:"0 8px 24px #00000099", minWidth:200 }}>
                  <div style={{ padding:"6px 12px", fontSize:8.5, color:"#475569",
                    borderBottom:"1px solid #1E293B", fontWeight:700, letterSpacing:0.8 }}>
                    {sessions.filter(s=>s.dur>0).length} SESSION{sessions.filter(s=>s.dur>0).length>1?"S":""} — W{wn} {DAY_NAMES[di]}
                  </div>
                  <button onClick={() => {
                    sessions.forEach((_, si) => { if (week[di][si].dur) openGCal(di,si); });
                    setDayMenu(null);
                  }} style={{ display:"flex", alignItems:"center", gap:8, width:"100%",
                    padding:"9px 13px", background:"transparent", border:"none",
                    borderBottom:"1px solid #1E293B", color:"#E2E8F0", cursor:"pointer",
                    fontSize:10.5, fontWeight:600, textAlign:"left" }}>
                    <GCalIcon/> All sessions → Google
                  </button>
                  <button onClick={() => {
                    sessions.forEach((_, si) => { if (week[di][si].dur) dlDayICS(di,si); });
                    setDayMenu(null);
                  }} style={{ display:"flex", alignItems:"center", gap:8, width:"100%",
                    padding:"9px 13px", background:"transparent", border:"none",
                    color:"#E2E8F0", cursor:"pointer", fontSize:10.5, fontWeight:600, textAlign:"left" }}>
                    <AppleIcon/> All sessions → .ics
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── LEGEND ── */}
      <div style={{ margin:"16px 16px 0", padding:"11px 14px",
        background:"#0A0D14", border:"1px solid #111827", borderRadius:7 }}>
        <div style={{ fontSize:8, letterSpacing:2, color:"#1E293B", fontWeight:700, marginBottom:8 }}>
          SESSION TYPES & FIXES
        </div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:5, marginBottom:8 }}>
          {Object.entries(TYPE).map(([k, v]) => (
            <div key={k} style={{ display:"flex", alignItems:"center", gap:4, padding:"3px 7px",
              background:v.bg, border:`1px solid ${v.color}55`, borderRadius:4 }}>
              <span style={{ fontSize:10 }}>{v.icon}</span>
              <span style={{ fontSize:8, fontWeight:700, color:v.color }}>{v.label}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize:8.5, color:"#334155", lineHeight:1.8 }}>
          <b style={{ color:"#F97316" }}>v2 fixes:</b>&nbsp;
          Dynamic FTP (retests W14/22/30) · Single VO2/week · Rep scheme periodization (ACC→INT→PEAK in base, ACC2 reset W15+) ·
          Lower body arc (full W1–18 · maint W19–30 · biweekly W31–35 · none W37–38) ·
          Sunday Z2 cap in Threshold & VO2 · Sprints 150–180% FTP for 20s · Disruption protocol.&nbsp;
          All sessions at <b style={{ color:"#3B82F6" }}>4:30 AM</b> · 15-min reminder included.
        </div>
      </div>

    </div>
  );
}
