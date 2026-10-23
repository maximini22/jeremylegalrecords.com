/* Guitar Tab data model (schemaVersion 5). MIDI-ready: ticks at a fixed PPQ, tuning as MIDI note numbers.
 * One project = one shared timeline (BPM, time signature, length, loop) with up to 3 tracks.
 * Each track has its own tuning, note style (plain / dotted / triplet), notes and mixer settings. See docs/USER-GUIDE.md. Exposed as window.TabModel. */
(function () {
  'use strict';
  var SCHEMA = 'jlr-guitar-tab';
  var SCHEMA_VERSION = 5; // 5 (v8): note style per track; the project grid keeps only the value
  var PPQ = 480;
  var STRINGS = 6;
  var MAX_FRET = 22; // frets 0-22 (was 16 up to v5; files from then are a subset)
  var LIMITS = { projects: 500, tracks: 3, importTracks: 64, measures: 999, notes: 20000, title: 120, name: 60, idea: 500 };

  // Exactly six tunings. MIDI notes listed string 1 (highest) to string 6 (lowest), the same order as the tab rows.
  var TUNINGS = [
    { id: 'c-standard', name: 'C standard (C F Bb Eb G C)', midi: [60, 55, 51, 46, 41, 36], labels: ['c', 'G', 'Eb', 'Bb', 'F', 'C'] },
    { id: 'drop-c', name: 'Drop C (C G C F A D)', midi: [62, 57, 53, 48, 43, 36], labels: ['d', 'A', 'F', 'C', 'G', 'C'] },
    { id: 'd-standard', name: 'D standard (D G C F A D)', midi: [62, 57, 53, 48, 43, 38], labels: ['d', 'A', 'F', 'C', 'G', 'D'] },
    { id: 'drop-d', name: 'Drop D (D A D G B E)', midi: [64, 59, 55, 50, 45, 38], labels: ['e', 'B', 'G', 'D', 'A', 'D'] },
    { id: 'e-standard', name: 'E standard (E A D G B E)', midi: [64, 59, 55, 50, 45, 40], labels: ['e', 'B', 'G', 'D', 'A', 'E'] },
    { id: 'open-g', name: 'Open G (D G D G B D)', midi: [62, 59, 55, 50, 43, 38], labels: ['d', 'B', 'G', 'D', 'G', 'D'] }
  ];
  var DEFAULT_TUNING = 'e-standard';
  var CUSTOM = { id: 'custom', name: 'Custom (imported)' };
  var TUNING_BY_ID = {};
  TUNINGS.forEach(function (t) { TUNING_BY_ID[t.id] = t; });

  // Grid / note values. The grid is one value (whole .. 64th) plus an optional style: dotted (x1.5) or triplet (x2/3).
  // Every combination is a whole number of ticks at PPQ 480 (dotted 64th = 45, 64th triplet = 20).
  var DUR_VALUES = ['whole', 'half', 'quarter', 'eighth', 'sixteenth', 'thirtysecond', 'sixtyfourth'];
  var DUR_QUARTERS = { whole: 4, half: 2, quarter: 1, eighth: 0.5, sixteenth: 0.25, thirtysecond: 0.125, sixtyfourth: 0.0625 };
  var DUR_LETTER = { whole: 'W', half: 'H', quarter: 'Q', eighth: 'E', sixteenth: 'S', thirtysecond: 'T', sixtyfourth: 'X' };
  var DUR_FRACTION = { whole: '1/1', half: '1/2', quarter: '1/4', eighth: '1/8', sixteenth: '1/16', thirtysecond: '1/32', sixtyfourth: '1/64' };
  var DUR_NAME = { whole: 'whole', half: 'half', quarter: 'quarter', eighth: 'eighth', sixteenth: '16th', thirtysecond: '32nd', sixtyfourth: '64th' };
  var BEAMS = { eighth: 1, sixteenth: 2, thirtysecond: 3, sixtyfourth: 4 }; // beams (or flags) per value
  var TRIPLET = { actual: 3, normal: 2 };
  var GRID_STYLES = ['plain', 'dotted', 'triplet'];
  var TIME_SIGS = ['4/4', '3/4', '2/4', '6/8'];
  var TECHNIQUES = ['muted', 'hammer-on', 'pull-off', 'slide', 'bend', 'vibrato', 'palm-mute', 'harmonic', 'tap', 'let-ring'];
  var DEFAULT_VOLUME = 80;

  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
  function nowIso() { return new Date().toISOString(); }
  function clampInt(v, lo, hi) { v = Math.round(Number(v)); if (!isFinite(v)) v = lo; return Math.max(lo, Math.min(hi, v)); }
  function isInt(v, lo, hi) { return typeof v === 'number' && v % 1 === 0 && v >= lo && v <= hi; }

  // Ticks of a {value, dotted, tuplet} length (grid or named note spacing).
  function durTicks(d) {
    var t = PPQ * DUR_QUARTERS[d.value];
    if (d.dotted) t *= 1.5;
    if (d.tuplet) t = t * d.tuplet.normal / d.tuplet.actual;
    return Math.round(t);
  }
  function isTriplet(d) { return !!(d && d.tuplet && d.tuplet.actual === 3 && d.tuplet.normal === 2); }
  function gridStyle(d) { return d && d.dotted ? 'dotted' : isTriplet(d) ? 'triplet' : 'plain'; }
  // Short label: Q, Q. (dotted), Q³ (triplet).
  function durLabel(d) { return DUR_LETTER[d.value] + (d.dotted ? '.' : '') + (isTriplet(d) ? '³' : ''); }
  // Grid label: 1/8, 1/8. or 1/8T, and the spoken name: eighth, dotted eighth, eighth triplet.
  function gridLabel(d) { return DUR_FRACTION[d.value] + (d.dotted ? '.' : '') + (isTriplet(d) ? 'T' : ''); }
  function gridName(d) { return (d.dotted ? 'dotted ' : '') + DUR_NAME[d.value] + (isTriplet(d) ? ' triplet' : ''); }
  function defaultGrid() { return { value: 'eighth' }; }
  // The one canonical grid object per value + style: {value}, {value, dotted: true} or {value, tuplet: {3:2}}.
  function makeGrid(value, style) {
    var g = { value: DUR_VALUES.indexOf(value) < 0 ? 'eighth' : value };
    if (style === 'dotted') g.dotted = true;
    else if (style === 'triplet') g.tuplet = { actual: TRIPLET.actual, normal: TRIPLET.normal };
    return g;
  }
  // Any stored grid -> canonical value + style. Dotted and 3:2 triplet grids are kept as they are. Only grids
  // the app can't show are changed (and reported): other tuplets (e.g. 5:4) drop to the plain value, and a
  // dotted triplet keeps the triplet.
  function normGrid(g) {
    if (!g || DUR_VALUES.indexOf(g.value) < 0) return { grid: defaultGrid(), changed: !!g };
    var odd = g.tuplet && !isTriplet(g), both = !!g.dotted && isTriplet(g);
    var style = isTriplet(g) ? 'triplet' : g.dotted && !g.tuplet ? 'dotted' : 'plain';
    return { grid: makeGrid(g.value, style), changed: !!(odd || both) };
  }

  function measureTicks(p) { var ts = p.timeSignature; return Math.round(ts[0] * PPQ * 4 / ts[1]); }
  function beatTicks(p) {
    var ts = p.timeSignature;
    return (ts[1] === 8 && ts[0] % 3 === 0) ? PPQ * 1.5 : Math.round(PPQ * 4 / ts[1]);
  }
  function noteNames(midi) {
    var N = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    return midi.map(function (m) { return N[m % 12]; });
  }
  function tuningLabels(t) {
    var p = TUNING_BY_ID[t.id];
    if (p && p.midi.join() === t.midi.join()) return p.labels;
    return noteNames(t.midi);
  }
  function tuningFromId(id) { var p = TUNING_BY_ID[id] || TUNING_BY_ID[DEFAULT_TUNING]; return { id: p.id, name: p.name, midi: p.midi.slice() }; }
  // Any tuning whose MIDI matches one of the six becomes that preset; anything else keeps its MIDI as Custom (imported).
  function canonicalTuning(midi) {
    for (var i = 0; i < TUNINGS.length; i++) if (TUNINGS[i].midi.join() === midi.join()) return tuningFromId(TUNINGS[i].id);
    return { id: CUSTOM.id, name: CUSTOM.name, midi: midi.slice() };
  }

  // Standard lengths a note's spacing can be named as (rhythm row, text tab): every value plain, dotted and triplet.
  // All 21 tick counts are distinct, so a spacing has at most one name.
  var NAMED = [];
  GRID_STYLES.forEach(function (st) { DUR_VALUES.forEach(function (v) { var d = makeGrid(v, st); NAMED.push({ d: d, ticks: durTicks(d) }); }); });
  function nameTicks(t) { for (var i = 0; i < NAMED.length; i++) if (NAMED[i].ticks === t) return JSON.parse(JSON.stringify(NAMED[i].d)); return null; }

  function newTrack(name, tuningId) {
    return { id: uid(), name: name || 'Guitar', tuning: tuningFromId(tuningId || DEFAULT_TUNING), style: 'plain', volume: DEFAULT_VOLUME, mute: false, solo: false, notes: [] };
  }
  // A track's effective grid: the project's value (1/1 .. 1/64) with the track's own style.
  function trackStyle(t) { return t && GRID_STYLES.indexOf(t.style) >= 0 ? t.style : 'plain'; }
  function trackGrid(p, t) { return makeGrid(p.grid && p.grid.value, trackStyle(t)); }
  // A schemaVersion 4 copy of a library (what v7 and earlier read): each project's grid takes the armed track's
  // style, and the per-track styles are left out. Notes keep their ticks, so nothing moves.
  function toV4(lib) {
    var out = JSON.parse(JSON.stringify(lib));
    out.schemaVersion = 4;
    (out.projects || []).forEach(function (p) {
      var a = p.tracks.filter(function (t) { return t.id === p.activeTrackId; })[0] || p.tracks[0];
      p.grid = makeGrid(p.grid && p.grid.value, trackStyle(a));
      p.tracks.forEach(function (t) { delete t.style; });
      delete p.metronome;
    });
    return out;
  }
  function newProject(title) {
    var tr = newTrack('Guitar 1');
    var now = nowIso();
    var p = { id: uid(), title: title || '', bpm: 90, grid: defaultGrid(), timeSignature: [4, 4], lengthTicks: 0,
      loop: { enabled: false, startMeasure: 1, endMeasure: 1 }, metronome: false, idea: '', createdAt: now, updatedAt: now, activeTrackId: tr.id, tracks: [tr] };
    p.lengthTicks = measureTicks(p) * 2;
    return recompute(p);
  }
  function newLibrary() {
    var p = newProject('');
    return { schema: SCHEMA, schemaVersion: SCHEMA_VERSION, ppq: PPQ, activeProjectId: p.id, projects: [p] };
  }

  // Keep derived data in sync. Per track, notes are sorted by time then string; a note lasts until the next
  // note of that track starts, capped at one bar and at the end of the song. Song length = whole bars that
  // hold every note of every track.
  function recompute(p) {
    var mt = measureTicks(p), last = 0;
    p.tracks.forEach(function (t) {
      t.notes.sort(function (a, b) { return a.startTick - b.startTick || a.string - b.string; });
      if (t.notes.length) last = Math.max(last, t.notes[t.notes.length - 1].startTick + 1);
    });
    var need = Math.max(mt, Math.ceil(last / mt) * mt);
    p.lengthTicks = Math.max(need, Math.ceil((p.lengthTicks || mt) / mt) * mt);
    if (p.lengthTicks > mt * LIMITS.measures) p.lengthTicks = mt * LIMITS.measures;
    p.tracks.forEach(function (t) {
      var onsets = []; t.notes.forEach(function (n) { if (onsets[onsets.length - 1] !== n.startTick) onsets.push(n.startTick); });
      var k = 0;
      t.notes.forEach(function (n) {
        while (k < onsets.length && onsets[k] <= n.startTick) k++;
        var next = k < onsets.length ? onsets[k] : p.lengthTicks;
        n.durationTicks = Math.max(1, Math.min(next - n.startTick, mt, p.lengthTicks - n.startTick));
      });
    });
    var mc = measureCount(p), L = p.loop;
    L.startMeasure = clampInt(L.startMeasure, 1, mc);
    L.endMeasure = clampInt(L.endMeasure, L.startMeasure, mc);
    return p;
  }
  function measureCount(p) { return Math.max(1, Math.ceil((p.lengthTicks || 0) / measureTicks(p))); }
  function measureOfTick(p, t) { return Math.floor(t / measureTicks(p)) + 1; }

  // Grid cells for the project at a resolution. Cells restart at every barline. Returns [{start, len, measure}].
  function cells(p, grid) {
    var mt = measureTicks(p), g = durTicks(grid), out = [];
    for (var m0 = 0; m0 < p.lengthTicks; m0 += mt) {
      for (var t = 0; t < mt; t += g) out.push({ start: m0 + t, len: Math.min(g, mt - t), measure: m0 / mt + 1 });
    }
    return out;
  }
  function cellIndexAt(cl, tick) {
    var lo = 0, hi = cl.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (cl[mid].start <= tick) lo = mid; else hi = mid - 1; }
    return lo;
  }

  // Solo logic: if any track is soloed, only soloed (and not muted) tracks play; otherwise every unmuted track plays.
  function audibleTracks(p) {
    var anySolo = p.tracks.some(function (t) { return t.solo; });
    return p.tracks.filter(function (t) { return !t.mute && (!anySolo || t.solo); });
  }

  // ---------- validation ----------
  function checkDur(d, where) {
    if (!d || DUR_VALUES.indexOf(d.value) < 0) return where + ': unknown note length.';
    if (d.tuplet != null && !(d.tuplet && isInt(d.tuplet.actual, 2, 9) && isInt(d.tuplet.normal, 1, 8))) return where + ': bad tuplet.';
    return null;
  }
  function checkEvent(ev, w) {
    if (!ev || !isInt(ev.string, 1, STRINGS)) return w + ': bad string.';
    if (!(ev.fret === null || isInt(ev.fret, 0, MAX_FRET))) return w + ': fret must be 0 to ' + MAX_FRET + '.';
    if (!Array.isArray(ev.techniques) || ev.techniques.length > 10 || !ev.techniques.every(function (x) { return typeof x === 'string' && x.length <= 30; })) return w + ': bad techniques.';
    if (ev.fret === null && ev.techniques.indexOf('muted') < 0) return w + ': a note with no fret must be muted.';
    return null;
  }
  function checkTiming(o, where) {
    if (!Array.isArray(o.timeSignature) || TIME_SIGS.indexOf(o.timeSignature.join('/')) < 0) return where + ': unsupported time signature.';
    return null;
  }
  function checkTrackBase(t, where, v) {
    if (!t || typeof t !== 'object') return where + ' is not a track.';
    if (typeof t.name !== 'string' || t.name.length > 200) return where + ': bad name.';
    if (!t.tuning || !Array.isArray(t.tuning.midi) || t.tuning.midi.length !== STRINGS || !t.tuning.midi.every(function (m) { return isInt(m, 0, 127 - MAX_FRET); })) return where + ': tuning must be 6 MIDI notes.';
    if (v < 4) { var e = checkTiming(t, where); if (e) return e; }
    return null;
  }
  // schemaVersion 2: steps with a duration each, events inside.
  function checkTrackV2(t, where) {
    var e0 = checkTrackBase(t, where, 2); if (e0) return e0;
    if (!Array.isArray(t.steps) || t.steps.length < 1 || t.steps.length > 4000) return where + ': needs 1 to 4000 steps.';
    for (var i = 0; i < t.steps.length; i++) {
      var s = t.steps[i], w = where + ' step ' + (i + 1);
      var e = checkDur(s && s.duration, w); if (e) return e;
      if (!Array.isArray(s.events) || s.events.length > STRINGS) return w + ': bad events.';
      var seen = {};
      for (var j = 0; j < s.events.length; j++) {
        var ee = checkEvent(s.events[j], w); if (ee) return ee;
        if (seen[s.events[j].string]) return w + ': repeated string.'; seen[s.events[j].string] = 1;
      }
    }
    return null;
  }
  function checkNotes(t, where, maxT) {
    if (!Array.isArray(t.notes) || t.notes.length > LIMITS.notes) return where + ': bad notes.';
    var seen = {};
    for (var i = 0; i < t.notes.length; i++) {
      var n = t.notes[i], w = where + ' note ' + (i + 1);
      var e = checkEvent(n, w); if (e) return e;
      if (!isInt(n.startTick, 0, maxT - 1)) return w + ': bad startTick.';
      var key = n.string + ':' + n.startTick; if (seen[key]) return w + ': two notes on one string at the same time.'; seen[key] = 1;
    }
    return null;
  }
  // schemaVersion 3: absolute-tick notes, timing per track.
  function checkTrackV3(t, where) {
    var e0 = checkTrackBase(t, where, 3); if (e0) return e0;
    var maxT = measureTicks(t) * LIMITS.measures;
    if (!isInt(t.lengthTicks, 1, maxT)) return where + ': bad lengthTicks.';
    return checkNotes(t, where, maxT);
  }
  // schemaVersion 4: timing on the project, mixer on the track.
  function checkTrackV4(t, where, p) {
    var e0 = checkTrackBase(t, where, 4); if (e0) return e0;
    if (t.volume != null && !isInt(t.volume, 0, 100)) return where + ': volume must be 0 to 100.';
    if (t.mute != null && typeof t.mute !== 'boolean') return where + ': bad mute.';
    if (t.solo != null && typeof t.solo !== 'boolean') return where + ': bad solo.';
    if (t.style != null && GRID_STYLES.indexOf(t.style) < 0) return where + ': unknown note style.';
    return checkNotes(t, where, measureTicks(p) * LIMITS.measures);
  }
  function checkProject(p, where, v) {
    if (!p || typeof p !== 'object') return where + ' is not a project.';
    if (typeof p.id !== 'string' || !p.id || p.id.length > 64) return where + ': missing id.';
    if (typeof p.title !== 'string' || p.title.length > 200) return where + ': bad title.';
    if (!Array.isArray(p.tracks) || p.tracks.length < 1 || p.tracks.length > LIMITS.importTracks) return where + ': needs 1 to ' + LIMITS.importTracks + ' tracks.';
    if (v >= 3 && p.grid != null) { var g = checkDur(p.grid, where + ' grid'); if (g) return g; }
    if (v >= 4) {
      var e1 = checkTiming(p, where); if (e1) return e1;
      if (!isInt(p.lengthTicks, 1, measureTicks(p) * LIMITS.measures)) return where + ': bad lengthTicks.';
      if (p.idea != null && (typeof p.idea !== 'string' || p.idea.length > 5000)) return where + ': bad idea notes.';
    }
    for (var i = 0; i < p.tracks.length; i++) {
      var w = where + ' track ' + (i + 1);
      var e = v >= 4 ? checkTrackV4(p.tracks[i], w, p) : (v === 3 ? checkTrackV3 : checkTrackV2)(p.tracks[i], w);
      if (e) return e;
    }
    return null;
  }

  // Returns { error } or { projects, kind, migratedFrom, warnings } with normalised, recomputed v4 data.
  // Reads v4, upgrades v3 (per-track timing), v2 (steps with durations) and v1 (single-tab scaffold) files.
  function parseFile(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'Not a tab file.' };
    if (obj.schema !== SCHEMA) return { error: 'This is not a Guitar Tab file.' };
    if (obj.schemaVersion == null && obj.version === 1) return migrateV1(obj);
    if (!isInt(obj.schemaVersion, 2, 1000)) return { error: 'Missing or unsupported schemaVersion.' };
    var v = obj.schemaVersion;
    if (v > SCHEMA_VERSION) return { error: 'This file was made by a newer version of Guitar Tab (schemaVersion ' + v + '; this app reads up to ' + SCHEMA_VERSION + '). Reload the app to update it, then import the file again.', newer: true };
    if (obj.ppq !== PPQ) return { error: 'Unsupported ppq ' + obj.ppq + ' (expected ' + PPQ + ').' };
    if (!Array.isArray(obj.projects) || obj.projects.length < 1 || obj.projects.length > LIMITS.projects) return { error: 'No projects in file.' };
    for (var i = 0; i < obj.projects.length; i++) { var e = checkProject(obj.projects[i], 'Project ' + (i + 1), v); if (e) return { error: e }; }
    var warnings = [];
    var projects = obj.projects.map(function (p) {
      var q = p;
      if (v === 2) q = upgradeV2Project(q);
      if (v <= 3) q = upgradeV3Project(q, warnings);
      return normaliseProject(q, warnings);
    });
    return { kind: obj.kind === 'library' ? 'library' : 'project', projects: projects, activeProjectId: obj.activeProjectId,
      migratedFrom: v < SCHEMA_VERSION ? v : null, warnings: warnings };
  }
  // v2 -> v3: each step's events become notes at the step's absolute start tick. The grid becomes the most common step length.
  function upgradeV2Project(p) {
    var counts = {}, best = null;
    var tracks = p.tracks.map(function (t) {
      var tick = 0, notes = [];
      t.steps.forEach(function (s) {
        var d = { value: s.duration.value, dotted: !!s.duration.dotted, tuplet: s.duration.tuplet || null }, k = JSON.stringify(d);
        counts[k] = (counts[k] || 0) + 1;
        if (!best || counts[k] > counts[best]) best = k;
        s.events.forEach(function (e) { notes.push({ string: e.string, fret: e.fret, startTick: tick, durationTicks: 0, techniques: e.techniques.slice() }); });
        tick += durTicks(d);
      });
      var mt = measureTicks(t);
      return { id: t.id, name: t.name, tuning: t.tuning, timeSignature: t.timeSignature, loop: t.loop,
        lengthTicks: Math.max(mt, Math.min(mt * LIMITS.measures, Math.ceil(tick / mt) * mt)), notes: notes };
    });
    var out = {}; for (var key in p) out[key] = p[key];
    out.tracks = tracks; out.grid = best ? JSON.parse(best) : defaultGrid();
    return out;
  }
  // v3 -> v4: time signature and loop move from the tracks to the project (taken from the active track),
  // song length = longest track. Notes keep their absolute ticks, so nothing moves in time.
  function upgradeV3Project(p, warnings) {
    var src = p.tracks.filter(function (t) { return t.id === p.activeTrackId; })[0] || p.tracks[0];
    var ts = src.timeSignature.slice();
    var mixed = p.tracks.some(function (t) { return t.timeSignature.join('/') !== ts.join('/'); });
    if (mixed) warnings.push('"' + (p.title || 'Untitled') + '": tracks had different time signatures; the song now uses ' + ts.join('/') + ' (notes kept their timing).');
    var loop = src.loop && src.loop.enabled ? src.loop : (p.tracks.filter(function (t) { return t.loop && t.loop.enabled; })[0] || src).loop;
    var len = 0; p.tracks.forEach(function (t) { len = Math.max(len, t.lengthTicks || 0); });
    var out = {}; for (var key in p) out[key] = p[key];
    out.timeSignature = ts;
    out.loop = { enabled: !!(loop && loop.enabled), startMeasure: (loop && loop.startMeasure) || 1, endMeasure: (loop && loop.endMeasure) || 1 };
    out.lengthTicks = len || measureTicks(out) * 2;
    out.idea = '';
    out.tracks = p.tracks.map(function (t) { return { id: t.id, name: t.name, tuning: t.tuning, notes: t.notes }; });
    return out;
  }
  function normaliseProject(p, warnings) {
    warnings = warnings || [];
    var now = nowIso(), label = '"' + (p.title || 'Untitled') + '"';
    var src = p.tracks;
    if (src.length > LIMITS.tracks) {
      warnings.push(label + ' had ' + src.length + ' tracks; kept the first ' + LIMITS.tracks + '.');
      src = src.slice(0, LIMITS.tracks);
    }
    var seenIds = {};
    // v8: the note style lives on each track. Older files (one style for the whole project) give it to every track.
    var g = normGrid(p.grid), projStyle = gridStyle(g.grid);
    var tracks = src.map(function (t) {
      var id = typeof t.id === 'string' && t.id ? t.id.slice(0, 64) : uid();
      if (seenIds[id]) id = uid(); seenIds[id] = 1;
      var tun = canonicalTuning(t.tuning.midi);
      if (tun.id === 'custom' && TUNING_BY_ID[t.tuning.id] == null && t.tuning.id !== 'custom') warnings.push(label + ' track "' + t.name + '": tuning ' + (t.tuning.name || t.tuning.id) + ' shown as Custom (imported).');
      return {
        id: id, name: t.name.slice(0, LIMITS.name), tuning: tun, style: GRID_STYLES.indexOf(t.style) >= 0 ? t.style : projStyle,
        volume: t.volume == null ? DEFAULT_VOLUME : clampInt(t.volume, 0, 100), mute: !!t.mute, solo: !!t.solo,
        notes: t.notes.map(function (n) { return { string: n.string, fret: n.fret, startTick: n.startTick, durationTicks: 0, techniques: n.techniques.slice(0, 10) }; })
      };
    });
    if (g.changed) warnings.push(label + ': grid ' + DUR_FRACTION[p.grid.value] + (p.grid.dotted ? ' dotted' : '') + (p.grid.tuplet ? ' ' + p.grid.tuplet.actual + ':' + p.grid.tuplet.normal + ' tuplet' : '') + ' is now ' + gridLabel(g.grid) + ' (notes did not move).');
    var active = tracks.some(function (t) { return t.id === p.activeTrackId; }) ? p.activeTrackId : tracks[0].id;
    var out = { id: p.id, title: p.title.slice(0, LIMITS.title), bpm: clampInt(p.bpm || 90, 30, 300), grid: { value: g.grid.value },
      timeSignature: p.timeSignature.slice(), lengthTicks: p.lengthTicks,
      loop: { enabled: !!(p.loop && p.loop.enabled), startMeasure: (p.loop && p.loop.startMeasure) || 1, endMeasure: (p.loop && p.loop.endMeasure) || 1 },
      metronome: p.metronome === true, // v8.2: metronome click on/off (optional; missing = off)
      idea: typeof p.idea === 'string' ? p.idea.slice(0, LIMITS.idea) : '',
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : now, updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : now,
      activeTrackId: active, tracks: tracks };
    return recompute(out);
  }
  // v1 scaffold files: { schema, version: 1, title, tuning: id, columns: [[6 values string 1..6]] }, every column a quarter note.
  var V1_TUNINGS = { standard: [64, 59, 55, 50, 45, 40], 'drop-d': [64, 59, 55, 50, 45, 38], dadgad: [62, 57, 55, 50, 45, 38], 'open-g': [62, 59, 55, 50, 43, 38] };
  function migrateV1(obj) {
    var midi = V1_TUNINGS[obj.tuning] || (TUNING_BY_ID[obj.tuning] && TUNING_BY_ID[obj.tuning].midi);
    if (!midi || !Array.isArray(obj.columns) || !obj.columns.length || obj.columns.length > 4000) return { error: 'Old tab file is damaged.' };
    var notes = [];
    for (var i = 0; i < obj.columns.length; i++) {
      var c = obj.columns[i];
      if (!Array.isArray(c) || c.length !== STRINGS) return { error: 'Old tab file is damaged.' };
      c.forEach(function (v, si) {
        if (v === 'x') notes.push({ string: si + 1, fret: null, startTick: i * PPQ, durationTicks: 0, techniques: ['muted'] });
        else if (isInt(v, 0, MAX_FRET)) notes.push({ string: si + 1, fret: v, startTick: i * PPQ, durationTicks: 0, techniques: [] });
      });
    }
    var p = newProject(typeof obj.title === 'string' ? obj.title.slice(0, LIMITS.title) : '');
    p.grid = { value: 'quarter' };
    p.tracks[0].tuning = canonicalTuning(midi);
    p.tracks[0].notes = notes;
    p.lengthTicks = Math.ceil(obj.columns.length * PPQ / measureTicks(p)) * measureTicks(p);
    if (typeof obj.createdAt === 'string') p.createdAt = obj.createdAt;
    return { kind: 'project', projects: [recompute(p)], migratedFrom: 1, warnings: [] };
  }

  function midiOf(track, ev) { return ev.fret === null ? null : track.tuning.midi[ev.string - 1] + ev.fret; }

  window.TabModel = {
    SCHEMA: SCHEMA, SCHEMA_VERSION: SCHEMA_VERSION, PPQ: PPQ, STRINGS: STRINGS, MAX_FRET: MAX_FRET, LIMITS: LIMITS,
    TUNINGS: TUNINGS, TUNING_BY_ID: TUNING_BY_ID, CUSTOM: CUSTOM, DUR_VALUES: DUR_VALUES, DUR_LETTER: DUR_LETTER, DUR_FRACTION: DUR_FRACTION,
    DUR_NAME: DUR_NAME, BEAMS: BEAMS, GRID_STYLES: GRID_STYLES,
    TIME_SIGS: TIME_SIGS, TECHNIQUES: TECHNIQUES, DEFAULT_VOLUME: DEFAULT_VOLUME,
    uid: uid, nowIso: nowIso, durTicks: durTicks, durLabel: durLabel, nameTicks: nameTicks, defaultGrid: defaultGrid, makeGrid: makeGrid, normGrid: normGrid,
    isTriplet: isTriplet, gridStyle: gridStyle, gridLabel: gridLabel, gridName: gridName,
    measureTicks: measureTicks, beatTicks: beatTicks, tuningLabels: tuningLabels, tuningFromId: tuningFromId, canonicalTuning: canonicalTuning,
    newTrack: newTrack, trackStyle: trackStyle, trackGrid: trackGrid, toV4: toV4, newProject: newProject, newLibrary: newLibrary, recompute: recompute, measureCount: measureCount,
    measureOfTick: measureOfTick, cells: cells, cellIndexAt: cellIndexAt, audibleTracks: audibleTracks,
    parseFile: parseFile, normaliseProject: normaliseProject, midiOf: midiOf
  };
})();
