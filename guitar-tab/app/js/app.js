/* Guitar Tab app (v8): DAW-style UI for up to 3 tab tracks (each with its own note style), chord library, library persistence,
 * undo/redo, import/export/share.
 * Uses TabModel (js/model.js) and TabAudio (js/audio.js). Browser-only: nothing is uploaded, nothing to install. */
(function () {
  'use strict';
  var M = window.TabModel, A = window.TabAudio;
  // v8 keeps its library (schemaVersion 5) under LIB_KEY and also writes a schemaVersion 4 copy to STORE_KEY,
  // the key v4-v7 read, so rolling back to v7 keeps every saved tab (see docs/ROLLBACK.md).
  var LIB_KEY = 'jlr-guitar-tab:library-v5';
  var STORE_KEY = 'jlr-guitar-tab:library';
  var OLD_KEY = 'jlr-guitar-tab:current'; // first scaffold (single tab), migrated on load
  var PH_KEY = 'jlr-guitar-tab:playheads';
  var HINT_KEY = 'jlr-guitar-tab:hint-v4-seen';
  var INLAYS = { 3: 1, 5: 1, 7: 1, 9: 1, 12: 2, 17: 1, 19: 1, 21: 1 }; // no dot at 15, by request
  var TUNING_SHORT = { 'c-standard': 'C std', 'drop-c': 'Drop C', 'd-standard': 'D std', 'drop-d': 'Drop D', 'e-standard': 'E std', 'open-g': 'Open G', custom: 'Custom' };

  // Browser-only app: never show an install prompt or banner.
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); });

  var $ = function (id) { return document.getElementById(id); };
  var els = {};
  ['save-state', 'menu-btn', 'play-start', 'play-btn', 'stop-btn', 'loop-toggle', 'click-toggle', 'bpm', 'bpm-down', 'bpm-up', 'grid-select', 'grid-dot', 'grid-trip', 'ph-info', 'undo-btn', 'redo-btn',
   'tracks', 'ruler-wrap', 'ruler', 'editor-wrap', 'editor', 'idea', 'drawer', 'drawer-scrim', 'project-select', 'title', 'track-name',
   'tuning', 'timesig', 'loop-info', 'ascii', 'import-file', 'share-btn', 'picker', 'scrim', 'picker-sub', 'neck', 'picker-strings',
   'picker-grid', 'pick-mute', 'picker-tip', 'toast', 'modal', 'modal-scrim', 'modal-h', 'modal-body', 'modal-actions', 'hint', 'song-info',
   'picker-roll', 'roll-bar', 'picker-undo', 'picker-redo', 'grid-trk', 'grid-style', 'chords-open'
  ].forEach(function (id) { els[id.replace(/-(\w)/g, function (_, c) { return c.toUpperCase(); })] = $(id); });

  var lib = null;
  var cur = { cell: 0, str: 0 }; // edit cursor (insert position): grid step index + string index (0 = high e)
  var pickerOpen = false, drawerOpen = false;
  var playingStep = null, playProject = null;
  // Playhead: where Play resumes, as a tick, per project. Kept apart from the edit cursor and never exported.
  var playheads = {};
  try { playheads = JSON.parse(localStorage.getItem(PH_KEY) || '{}') || {}; } catch (e) { playheads = {}; }

  // ---------- accessors ----------
  function project() { return lib.projects.filter(function (p) { return p.id === lib.activeProjectId; })[0] || lib.projects[0]; }
  function track() { var p = project(); return p.tracks.filter(function (t) { return t.id === p.activeTrackId; })[0] || p.tracks[0]; }
  function tindex(t) { return project().tracks.indexOf(t); }
  function cellText(ev) { return !ev ? '' : ev.fret === null ? 'x' : String(ev.fret); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clampCur() { cur.cell = Math.max(0, Math.min(CL.length - 1, cur.cell)); }

  // ---------- persistence ----------
  function save() {
    var p = project(); p.updatedAt = M.nowIso();
    try {
      localStorage.setItem(LIB_KEY, JSON.stringify(lib));
      try { localStorage.setItem(STORE_KEY, JSON.stringify(M.toV4(lib))); } catch (e1) { /* the v7 copy is a courtesy */ }
      var d = new Date();
      els.saveState.textContent = 'Saved ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      els.saveState.className = 'save-state ok';
    } catch (e) {
      els.saveState.textContent = 'Not saved';
      els.saveState.className = 'save-state';
    }
  }
  function loadLibrary() {
    try {
      var raw = localStorage.getItem(LIB_KEY), v4raw = localStorage.getItem(STORE_KEY);
      // If an older version (after a rollback) saved since, its v4 copy no longer matches ours: take its copy.
      if (raw && v4raw) { try { if (JSON.stringify(M.toV4(JSON.parse(raw))) !== v4raw) raw = null; } catch (e3) { raw = null; } }
      if (!raw) raw = v4raw;
      if (raw) {
        var obj = JSON.parse(raw), r = M.parseFile(obj);
        if (!r.error) {
          var l = M.newLibrary(); l.projects = r.projects;
          l.activeProjectId = r.projects.some(function (p) { return p.id === obj.activeProjectId; }) ? obj.activeProjectId : r.projects[0].id;
          // An older library is upgraded in place; keep the original once as a backup.
          if (r.migratedFrom) { try { if (!localStorage.getItem(STORE_KEY + '-v' + r.migratedFrom + '-backup')) localStorage.setItem(STORE_KEY + '-v' + r.migratedFrom + '-backup', raw); } catch (e2) { /* full */ } }
          return { lib: l, restored: true, migratedFrom: r.migratedFrom, warnings: r.warnings };
        }
      }
      var old = localStorage.getItem(OLD_KEY);
      if (old) {
        var r1 = M.parseFile(JSON.parse(old));
        if (!r1.error) { var l1 = M.newLibrary(); l1.projects = r1.projects; l1.activeProjectId = r1.projects[0].id; return { lib: l1, restored: true, migratedFrom: 1, warnings: [] }; }
      }
    } catch (e) { /* fall through to a fresh library */ }
    return { lib: M.newLibrary(), restored: false, warnings: [] };
  }
  function changed(opts) {
    M.recompute(project()); checkpoint(); save(); render();
    if (opts && opts.scroll) scrollToCur();
  }

  // ---------- undo / redo ----------
  // Snapshot history per project (in memory, up to 100 steps). Mixer moves (volume, mute, solo), the armed
  // track and the idea notes are not undo steps, as in most DAWs; everything else is.
  var hist = {};
  function snapOf(p) {
    var c = JSON.parse(JSON.stringify(p));
    delete c.updatedAt; delete c.activeTrackId; delete c.idea;
    c.tracks.forEach(function (t) { delete t.volume; delete t.mute; delete t.solo; });
    return JSON.stringify(c);
  }
  function H() { var p = project(); if (!hist[p.id]) hist[p.id] = { undo: [], redo: [], base: snapOf(p) }; return hist[p.id]; }
  function checkpoint() {
    var h = H(), s = snapOf(project());
    if (s !== h.base) { h.undo.push(h.base); if (h.undo.length > 100) h.undo.shift(); h.redo = []; h.base = s; }
    undoUi();
  }
  function restore(s) {
    var p = project(), o = JSON.parse(s), mix = {}, tick = CL[cur.cell] ? CL[cur.cell].start : 0;
    p.tracks.forEach(function (t) { mix[t.id] = { volume: t.volume, mute: t.mute, solo: t.solo }; });
    Object.keys(o).forEach(function (k) { if (k !== 'id') p[k] = o[k]; });
    p.tracks.forEach(function (t) { var m = mix[t.id] || { volume: M.DEFAULT_VOLUME, mute: false, solo: false }; t.volume = m.volume; t.mute = m.mute; t.solo = m.solo; });
    if (!p.tracks.some(function (t) { return t.id === p.activeTrackId; })) p.activeTrackId = p.tracks[0].id;
    M.recompute(p); CL = cellsOf(); cur.cell = M.cellIndexAt(CL, tick); save(); render();
  }
  function undo() { checkpoint(); var h = H(); if (!h.undo.length) return; h.redo.push(h.base); h.base = h.undo.pop(); restore(h.base); toast('Undo'); }
  function redo() { checkpoint(); var h = H(); if (!h.redo.length) return; h.undo.push(h.base); h.base = h.redo.pop(); restore(h.base); toast('Redo'); }
  function undoUi() { var h = H(); els.undoBtn.disabled = !h.undo.length; els.redoBtn.disabled = !h.redo.length; }

  // ---------- grid ----------
  // The grid value (1/1 .. 1/64) is one per project; the style (plain, dotted or triplet) is per track (v8), so a
  // triplet lead can sit over a straight rhythm part. The editor shows the armed track's steps: every column is one
  // of its grid steps (steps restart at each barline). Notes keep their absolute startTick, so changing a grid or
  // style only changes how they are drawn and stepped through.
  function gridOf(t) { var p = project(); if (!p.grid) p.grid = M.defaultGrid(); return M.trackGrid(p, t || track()); }
  function grid() { return gridOf(track()); }
  function cellsOf(t) { return M.cells(project(), gridOf(t)); }
  var CL = []; // cells of the armed track's grid, refreshed on every render
  // Run fn (which may change the armed track, a style or the grid) and keep the edit cursor, and the playback
  // position if playing, on the same tick.
  function keepTick(fn) {
    var p = project(), tick = CL[cur.cell] ? CL[cur.cell].start : 0, wasPlaying = A.isPlaying() && playProject === p.id, playTick = playheads[p.id] || 0;
    fn();
    CL = cellsOf(); cur.cell = M.cellIndexAt(CL, tick);
    return function () { if (wasPlaying && project() === p) startPlayback(M.cellIndexAt(CL, playTick)); };
  }
  function cell(i) { return CL[i == null ? cur.cell : i]; }
  function notesIn(tr, c) { return tr.notes.filter(function (n) { return n.startTick >= c.start && n.startTick < c.start + c.len; }); }
  function notesOn(tr, c, no) { return notesIn(tr, c).filter(function (n) { return n.string === no; }); }
  function buckets(tr, cl) { cl = cl || CL; var b = cl.map(function () { return []; }); tr.notes.forEach(function (n) { b[M.cellIndexAt(cl, n.startTick)].push(n); }); return b; }
  function gridFrac(g) { return M.gridLabel(g); }
  function lenLabel(ticks) {
    var d = M.nameTicks(ticks);
    return d ? { text: M.durLabel(d), d: d } : { text: '~', d: null };
  }

  // ---------- rhythm row (derived from note spacing of the armed track) ----------
  function groups(p, cl, bk) {
    var bt = M.beatTicks(p);
    var info = cl.map(function (c, i) {
      var first = bk[i][0] || null, L = first ? lenLabel(first.durationTicks) : null;
      return { measure: c.measure, barStart: i === 0 || c.measure !== cl[i - 1].measure, onset: !!first,
        len: L ? L.text : '', d: L ? L.d : null, beam: '', beamLevels: 0, stem: false, dot: !!(L && L.d && L.d.dotted), tp: '', tpNum: false, tpBracket: false,
        start: c.start, end: first ? first.startTick + first.durationTicks : c.start };
    });
    // Eighths and shorter (plain, dotted or triplet) take 1-4 beams, beamed together within a beat; a lone one gets flags.
    var beamable = function (g) { return g.onset && g.d && !!M.BEAMS[g.d.value]; };
    info.forEach(function (g) { g.stem = g.onset && !(g.d && g.d.value === 'whole'); });
    var i = 0;
    while (i < cl.length) {
      if (!beamable(info[i])) { i++; continue; }
      var beat = Math.floor(cl[i].start / bt), j = i, last = i;
      while (j + 1 < cl.length && Math.floor(cl[j + 1].start / bt) === beat && (beamable(info[j + 1]) || !info[j + 1].onset)) { j++; if (beamable(info[j])) last = j; }
      var prevLv = 1;
      for (var k = i; k <= last; k++) {
        var g = info[k];
        g.beam = i === last ? 'flag' : k === i ? 'start' : k === last ? 'end' : 'mid';
        if (g.onset) { g.beamLevels = M.BEAMS[g.d.value]; prevLv = g.beamLevels; }
        else { // a held step inside the group: carry the beams the notes on both sides share
          var nx = k + 1; while (nx <= last && !info[nx].onset) nx++;
          g.beamLevels = Math.min(prevLv, nx <= last ? M.BEAMS[info[nx].d.value] : 1); g.stem = false;
        }
      }
      i = last + 1;
    }
    // Triplets: notes of one value in the same triplet span (3 notes = 2 of the plain value, counted from the bar line)
    // are one group, marked "3". Beamed triplets (eighth and shorter) show the number; quarter/half/whole get a bracket.
    var mt = M.measureTicks(p), keyOf = function (g) { var span = 3 * M.durTicks(g.d); return g.measure + ':' + g.d.value + ':' + Math.floor((g.start - (g.measure - 1) * mt) / span); };
    var tg = [], curG = null;
    info.forEach(function (g, ix) {
      if (!g.onset) return;
      if (!g.d || !M.isTriplet(g.d)) { curG = null; return; }
      var key = keyOf(g);
      if (curG && curG.key === key) curG.b = ix; else { curG = { key: key, a: ix, b: ix, br: !M.BEAMS[g.d.value] }; tg.push(curG); }
    });
    tg.forEach(function (t) {
      var endTick = info[t.b].end, z = t.b;
      while (z + 1 < info.length && !info[z + 1].onset && info[z + 1].start < endTick && info[z + 1].measure === info[t.b].measure) z++;
      var mid = Math.floor((t.a + z) / 2);
      for (var q = t.a; q <= z; q++) {
        info[q].tp = t.a === z ? 'only' : q === t.a ? 'start' : q === z ? 'end' : 'mid';
        info[q].tpBracket = t.br; info[q].tpNum = q === mid;
      }
    });
    return info;
  }

  // ---------- playhead ----------
  function phTick() {
    var p = project(), v = playheads[p.id];
    if (v == null && playheads[p.activeTrackId] != null) v = playheads[p.activeTrackId]; // v3 kept it per track
    return Math.max(0, Math.min(p.lengthTicks - 1, v || 0));
  }
  function phCell() { return M.cellIndexAt(CL, phTick()); }
  function savePlayheads() {
    var live = {};
    lib.projects.forEach(function (p) { if (playheads[p.id]) live[p.id] = playheads[p.id]; });
    playheads = live;
    try { localStorage.setItem(PH_KEY, JSON.stringify(playheads)); } catch (e) { /* not fatal */ }
  }
  function setPlayhead(i, opts) {
    i = Math.max(0, Math.min(CL.length - 1, i));
    playheads[project().id] = CL[i].start;
    savePlayheads(); markPlayhead();
    if (!opts || !opts.noScroll) scrollToCur(i);
  }
  function loopCells(p, cl) {
    var L = p.loop; if (!L.enabled) return null;
    var a = -1, b = -1;
    cl.forEach(function (c, i) { if (c.measure >= L.startMeasure && c.measure <= L.endMeasure) { if (a < 0) a = i; b = i; } });
    return a < 0 ? null : { a: a, b: b };
  }
  // bar|beat|sixteenth, as in a DAW position display (1|1|1 is the top of the song). Positions between 16ths
  // (32nd, 64th and triplet grids) add the ticks past that 16th: 1|1|1+60 (PPQ 480, so a 16th is 120 ticks).
  function posLabel(tick) {
    var p = project(), mt = M.measureTicks(p), bt = M.beatTicks(p), inBar = tick % mt, beat = Math.floor(inBar / bt), sub = inBar - beat * bt, r = sub % 120;
    return (Math.floor(tick / mt) + 1) + '|' + (beat + 1) + '|' + (Math.floor(sub / 120) + 1) + (r ? '+' + r : '');
  }
  function shownPh() { return A.isPlaying() && playingStep !== null && playProject === project().id ? playingStep : phCell(); }
  function markPlayhead(forced) {
    var ph = forced != null ? forced : shownPh();
    Array.prototype.forEach.call(els.editor.children, function (c, k) { if (k) c.classList.toggle('ph', k - 1 === ph); });
    Array.prototype.forEach.call(els.ruler.children, function (c, k) { if (k) { c.classList.toggle('ph', k - 1 === ph); c.setAttribute('aria-current', k - 1 === ph ? 'step' : 'false'); } });
    if (CL[ph]) { var pl = posLabel(CL[ph].start); els.phInfo.textContent = pl; els.phInfo.classList.toggle('long', pl.length > 6); fitPos(); els.phInfo.title = 'Playhead at bar|beat|16th(+ticks) ' + pl; }
  }
  function countLabel(c) {
    var p = project(), mt = M.measureTicks(p), bt = M.beatTicks(p), inBar = c.start % mt, off = inBar % bt;
    if (!off) return { text: String(Math.floor(inBar / bt) + 1), beat: true };
    if (off * 2 === bt) return { text: '&', beat: false };
    if (off * 4 === bt) return { text: 'e', beat: false };
    if (off * 4 === bt * 3) return { text: 'a', beat: false };
    if (off * 3 === bt || off * 3 === bt * 2) return { text: off * 3 === bt ? 'trip' : 'let', beat: false };
    return { text: '·', beat: false };
  }

  // ---------- rendering ----------
  // Bar|beat ruler: top lane = bar numbers + loop brace (drag to set), bottom lane = beat counts (tap/drag = playhead).
  function renderRuler(info) {
    var L = project().loop, frag = document.createDocumentFragment();
    var sp = document.createElement('div'); sp.className = 'r-lab';
    sp.innerHTML = '<span>bar</span><span class="r-g"></span>';
    sp.lastChild.textContent = gridFrac(grid());
    sp.title = 'Grid ' + gridFrac(grid()) + ' (' + M.gridName(grid()) + ')';
    frag.appendChild(sp);
    CL.forEach(function (c, ci) {
      var g = info[ci], inLoop = c.measure >= L.startMeasure && c.measure <= L.endMeasure, cnt = countLabel(c);
      var first = inLoop && (ci === 0 || CL[ci - 1].measure < L.startMeasure), last = inLoop && (ci === CL.length - 1 || CL[ci + 1].measure > L.endMeasure);
      var b = document.createElement('button'); b.type = 'button';
      b.className = 'rcol' + (g.barStart ? ' bar' : '') + (cnt.beat ? ' beat' : '') + (inLoop ? (L.enabled ? ' loop' : ' loop-off') : '') + (first ? ' ls' : '') + (last ? ' le' : '');
      b.dataset.step = ci;
      b.setAttribute('aria-label', 'Move playhead to ' + posLabel(c.start));
      var m = document.createElement('span'); m.className = 'r-m'; m.textContent = g.barStart ? c.measure : '';
      var n = document.createElement('span'); n.className = 'r-len'; n.textContent = cnt.text;
      b.appendChild(m); b.appendChild(n);
      frag.appendChild(b);
    });
    els.ruler.textContent = ''; els.ruler.appendChild(frag);
    syncRulerWidths();
  }
  function syncRulerWidths() {
    var ec = els.editor.children, rc = els.ruler.children;
    // read every width first, then write: interleaving forced a layout per column (seconds at 1/64 on long songs)
    var n = Math.min(rc.length, ec.length), w = new Array(n);
    for (var k = 0; k < n; k++) w[k] = ec[k].getBoundingClientRect().width;
    for (k = 0; k < n; k++) rc[k].style.width = w[k] + 'px';
    els.rulerWrap.scrollLeft = els.editorWrap.scrollLeft;
  }

  // Piano-roll style tab grid: 6 string lanes, time across. The armed track's notes are drawn in full;
  // the other tracks show as faint, colour-coded notes (or a coloured dot when the armed track also has one).
  function renderEditor() {
    var p = project(), tr = track(), ti = tindex(tr), labels = M.tuningLabels(tr.tuning), L = p.loop;
    CL = cellsOf(); clampCur();
    var BK = p.tracks.map(function (t) { return buckets(t); }), mine = BK[ti];
    var info = groups(p, CL, mine), ph = shownPh();
    els.editor.className = 'editor tc' + ti;
    var frag = document.createDocumentFragment();
    var lab = document.createElement('div'); lab.className = 'labels';
    labels.forEach(function (n) { var s = document.createElement('span'); s.textContent = n; lab.appendChild(s); });
    lab.insertAdjacentHTML('beforeend', '<div class="du">len</div><div class="bm"></div><div class="tp"></div>');
    frag.appendChild(lab);
    CL.forEach(function (c, ci) {
      var g = info[ci], col = document.createElement('div');
      var inLoop = c.measure >= L.startMeasure && c.measure <= L.endMeasure;
      col.className = 'col' + (ci === ph ? ' ph' : '') + (ci === cur.cell ? ' cur' : '') + (g.barStart ? ' bar' : '') +
        (ci === playingStep && playProject === p.id ? ' playing' : '') + (inLoop ? (L.enabled ? ' loop' : ' loop-off') : '');
      col.setAttribute('role', 'row');
      for (var si = 0; si < M.STRINGS; si++) {
        var here = mine[ci].filter(function (n) { return n.string === si + 1; }), ev = here[0] || null;
        var ghosts = [];
        BK.forEach(function (bk, k) { if (k === ti) return; var n = bk[ci].filter(function (x) { return x.string === si + 1; })[0]; if (n) ghosts.push({ k: k, n: n }); });
        var off = !!ev && ev.startTick !== c.start, b = document.createElement('button');
        b.type = 'button';
        b.className = 'cell' + (ev ? ' has' : '') + (ev && ev.fret === null ? ' mute' : '') + (off ? ' off' : '') + (here.length > 1 ? ' multi' : '') +
          (!ev && ghosts.length ? ' ghost g' + ghosts[0].k : '') + (ci === cur.cell && si === cur.str ? ' at' : '') + (pickerOpen && ci === cur.cell && si === cur.str ? ' sel' : '');
        b.dataset.col = ci; b.dataset.str = si;
        b.setAttribute('role', 'gridcell');
        var al = posLabel(c.start) + ', ' + labels[si] + ' string, ' + (!ev ? 'empty' : ev.fret === null ? 'muted' : 'fret ' + ev.fret) + (off ? ', off the grid' : '');
        ghosts.forEach(function (gh) { al += '; ' + (p.tracks[gh.k].name || 'Track ' + (gh.k + 1)) + ': ' + (gh.n.fret === null ? 'muted' : 'fret ' + gh.n.fret); });
        b.setAttribute('aria-label', al);
        var inner = document.createElement('b'); inner.textContent = ev ? cellText(ev) : ghosts.length ? cellText(ghosts[0].n) : ''; b.appendChild(inner);
        if (here.length > 1) { var sup = document.createElement('sup'); sup.textContent = '+' + (here.length - 1); b.appendChild(sup); }
        if (ev) ghosts.forEach(function (gh, gi) { var d = document.createElement('i'); d.className = 'gdot c' + gh.k + ' n' + gi; b.appendChild(d); });
        col.appendChild(b);
      }
      var du = document.createElement('div'); du.className = 'du' + (g.onset ? '' : ' cont'); du.textContent = g.len; col.appendChild(du);
      var bm = document.createElement('div'); bm.className = 'bm' + (g.beam ? ' b-' + g.beam + ' lv' + g.beamLevels : '') + (g.stem ? ' stem' : ' nostem') + (g.dot ? ' dot' : '');
      bm.innerHTML = '<i></i><i></i><i></i><i></i>'; col.appendChild(bm);
      var tp = document.createElement('div'); tp.className = 'tp' + (g.tp ? ' t-' + g.tp + (g.tpBracket ? ' br' : '') : '');
      if (g.tpNum) { var tn = document.createElement('span'); tn.textContent = '3'; tp.appendChild(tn); }
      col.appendChild(tp);
      frag.appendChild(col);
    });
    els.editor.textContent = '';
    els.editor.appendChild(frag);
    renderRuler(info);
    markPlayhead();
  }

  // Track header strip: arm (tap the name), colour, M, S, volume.
  function renderTracks() {
    var p = project(), aud = M.audibleTracks(p), frag = document.createDocumentFragment();
    p.tracks.forEach(function (t, i) {
      var armed = t.id === p.activeTrackId, name = t.name || 'Track ' + (i + 1);
      var row = document.createElement('div');
      row.className = 'trk c' + i + (armed ? ' armed' : '') + (aud.indexOf(t) < 0 ? ' silent' : '');
      row.dataset.track = t.id;
      var arm = document.createElement('button'); arm.type = 'button'; arm.className = 'trk-arm'; arm.dataset.act = 'arm';
      arm.setAttribute('aria-pressed', armed ? 'true' : 'false');
      arm.setAttribute('aria-label', (armed ? 'Editing ' : 'Edit ') + name + ', ' + (t.tuning.name || 'tuning'));
      var st = M.trackStyle(t);
      arm.innerHTML = '<i class="sw" aria-hidden="true"></i><span class="nm"></span>' + (st !== 'plain' ? '<em class="st"></em>' : '') + '<small></small>';
      arm.children[1].textContent = name;
      if (st !== 'plain') { arm.children[2].textContent = st === 'triplet' ? '3' : '·'; arm.children[2].className = 'st ' + st; arm.children[2].title = (st === 'triplet' ? 'Triplet' : 'Dotted') + ' feel'; }
      arm.lastChild.textContent = TUNING_SHORT[t.tuning.id] || 'Custom';
      if (st !== 'plain') arm.setAttribute('aria-label', arm.getAttribute('aria-label') + ', ' + st + ' feel');
      var mb = document.createElement('button'); mb.type = 'button'; mb.className = 'ms m' + (t.mute ? ' on' : ''); mb.dataset.act = 'mute'; mb.textContent = 'M';
      mb.setAttribute('aria-pressed', t.mute ? 'true' : 'false'); mb.setAttribute('aria-label', 'Mute ' + name);
      var sb = document.createElement('button'); sb.type = 'button'; sb.className = 'ms s' + (t.solo ? ' on' : ''); sb.dataset.act = 'solo'; sb.textContent = 'S';
      sb.setAttribute('aria-pressed', t.solo ? 'true' : 'false'); sb.setAttribute('aria-label', 'Solo ' + name);
      var vol = document.createElement('input'); vol.type = 'range'; vol.min = 0; vol.max = 100; vol.step = 1; vol.value = t.volume; vol.className = 'vol'; vol.dataset.act = 'vol';
      vol.setAttribute('aria-label', 'Volume ' + name); vol.title = 'Volume ' + t.volume;
      // v9: the track's Sound (opens the Sound list)
      var tn = M.trackTone(t), so = document.createElement('button'); so.type = 'button'; so.className = 'trk-snd' + toneCls(tn); so.dataset.act = 'tone';
      so.textContent = TONE_SHORT[tn] || 'Nylon'; so.setAttribute('aria-haspopup', 'listbox'); so.setAttribute('aria-expanded', 'false');
      so.setAttribute('aria-label', 'Sound for ' + name + ': ' + M.TONE_BY_ID[tn].name); so.title = 'Sound: ' + M.TONE_BY_ID[tn].name;
      row.appendChild(arm); row.appendChild(so); row.appendChild(mb); row.appendChild(sb); row.appendChild(vol);
      frag.appendChild(row);
    });
    if (p.tracks.length < M.LIMITS.tracks) {
      var add = document.createElement('button'); add.type = 'button'; add.className = 'trk-add'; add.id = 'track-add';
      add.textContent = '+ Track (' + p.tracks.length + '/' + M.LIMITS.tracks + ')';
      frag.appendChild(add);
    }
    els.tracks.textContent = ''; els.tracks.appendChild(frag);
    if (tonesAllowed) wantTones(p);
  }
  // ---------- Sounds (v9) ----------
  var TONE_SHORT = { nylon: 'Nylon', spanish: 'Spanish', clean: 'Clean', upright: 'Upright', ebass: 'E-bass' };
  var tonesAllowed = false, toneWarned = {}, playWait = null;
  function toneCls(id) { var st = A.toneState(id); return st === 'loading' ? ' loading' : st === 'error' ? ' failed' : ''; }
  // Load the Sounds a project uses (only after first paint; only ones never tried, so offline doesn't loop).
  function wantTones(p) { p.tracks.forEach(function (t) { var id = M.trackTone(t); if (A.toneState(id) === 'idle') A.load(id).catch(function () { toneFailed(id); }); }); }
  function toneFailed(id) {
    if (id === M.DEFAULT_TONE || toneWarned[id]) return; toneWarned[id] = 1;
    toast(M.TONE_BY_ID[id].name + " didn't load (offline?). Playing it as Nylon for now.");
  }
  function toneUi() {
    Array.prototype.forEach.call(els.tracks.querySelectorAll('.trk-snd'), function (b) {
      var row = b.closest('.trk'), t = project().tracks.filter(function (x) { return x.id === row.dataset.track; })[0];
      if (!t) return; var id = M.trackTone(t);
      b.classList.toggle('loading', A.toneState(id) === 'loading'); b.classList.toggle('failed', A.toneState(id) === 'error');
    });
  }
  function startTones() {
    if (tonesAllowed) return; tonesAllowed = true;
    A.load(M.DEFAULT_TONE).catch(function () { /* Play retries and explains */ });
    wantTones(project());
  }
  // The Sound list: one shared listbox, opened under (or above) a track's Sound button.
  var tonePop = null, toneFor = null;
  function closeTones(focusBack) {
    if (!tonePop || tonePop.hidden) return;
    tonePop.hidden = true;
    var b = els.tracks.querySelector('.trk-snd[aria-expanded="true"]');
    if (b) { b.setAttribute('aria-expanded', 'false'); if (focusBack) b.focus(); }
    toneFor = null;
  }
  function openTones(btn, tr) {
    if (!tonePop) {
      tonePop = document.createElement('div'); tonePop.className = 'tone-pop'; tonePop.id = 'tone-pop'; tonePop.setAttribute('role', 'listbox'); tonePop.hidden = true;
      M.TONES.forEach(function (d) {
        var o = document.createElement('button'); o.type = 'button'; o.className = 'tone-opt' + (d.bass ? ' bass' : ''); o.setAttribute('role', 'option'); o.dataset.tone = d.id;
        o.innerHTML = '<span></span><small></small>'; o.firstChild.textContent = d.name; o.lastChild.textContent = d.bass ? 'Bass · plays an octave down' : 'Guitar';
        tonePop.appendChild(o);
      });
      tonePop.addEventListener('click', function (e) { var o = e.target.closest('.tone-opt'); if (o) setTone(o.dataset.tone); });
      tonePop.addEventListener('keydown', function (e) {
        var os = Array.prototype.slice.call(tonePop.children), k = os.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); closeTones(true); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); os[(k + (e.key === 'ArrowDown' ? 1 : os.length - 1)) % os.length].focus(); }
      });
      document.body.appendChild(tonePop);
      document.addEventListener('pointerdown', function (e) { if (tonePop && !tonePop.hidden && !e.target.closest('#tone-pop, .trk-snd')) closeTones(); }, true);
    }
    toneFor = tr.id;
    var cur0 = M.trackTone(tr), sel = null;
    Array.prototype.forEach.call(tonePop.children, function (o) { var on = o.dataset.tone === cur0; o.setAttribute('aria-selected', on ? 'true' : 'false'); if (on) sel = o; });
    tonePop.setAttribute('aria-label', 'Sound for ' + (tr.name || 'track'));
    btn.setAttribute('aria-expanded', 'true');
    tonePop.hidden = false;
    var r = btn.getBoundingClientRect(), h = tonePop.offsetHeight, w = tonePop.offsetWidth, vh = window.innerHeight, vw = document.documentElement.clientWidth;
    var top = r.bottom + 4 + h <= vh - 4 ? r.bottom + 4 : Math.max(4, r.top - 4 - h);
    tonePop.style.top = Math.round(top) + 'px'; tonePop.style.left = Math.round(Math.max(6, Math.min(vw - w - 6, r.right - w))) + 'px';
    if (sel) sel.focus();
  }
  function setTone(id) {
    var p = project(), tr = p.tracks.filter(function (x) { return x.id === toneFor; })[0];
    closeTones(true);
    if (!tr || !M.TONE_BY_ID[id] || M.trackTone(tr) === id) return;
    tr.tone = id; changed();
    toast((tr.name || 'Track') + ': ' + M.TONE_BY_ID[id].name + (M.TONE_BY_ID[id].bass ? ' (sounds an octave below the tab)' : ''));
    if (!A.isReady(id)) {
      toneFor = null;
      A.load(id).then(function () { restartIfPlaying(); }, function () { toneFailed(id); });
    }
  }
  function refreshAudible() {
    var p = project(), aud = M.audibleTracks(p);
    Array.prototype.forEach.call(els.tracks.querySelectorAll('.trk'), function (row) {
      var t = p.tracks.filter(function (x) { return x.id === row.dataset.track; })[0];
      if (t) row.classList.toggle('silent', aud.indexOf(t) < 0);
    });
  }

  function renderTop() {
    var p = project(), L = p.loop;
    if (document.activeElement !== els.bpm) els.bpm.value = p.bpm;
    var gd = grid(), st = M.gridStyle(gd), tr = track(), ti = tindex(tr), nm = tr.name || 'Track ' + (ti + 1);
    els.gridSelect.value = gd.value;
    setToggle(els.gridDot, st === 'dotted'); setToggle(els.gridTrip, st === 'triplet');
    els.gridSelect.title = 'Grid ' + gridFrac(gd) + ' (' + M.gridName(gd) + ') · value for every track';
    // The style toggles set the armed track's feel: the coloured tab says which track that is.
    els.gridTrk.textContent = String(ti + 1); els.gridTrk.className = 'gs-trk c' + ti;
    els.gridTrk.title = 'Style for ' + nm;
    els.gridStyle.setAttribute('aria-label', 'Note style for ' + nm);
    els.gridDot.setAttribute('aria-label', 'Dotted, ' + nm); els.gridTrip.setAttribute('aria-label', 'Triplet, ' + nm);
    setToggle(els.loopToggle, L.enabled);
    setToggle(els.clickToggle, !!p.metronome); els.clickToggle.title = p.metronome ? 'Metronome on (M)' : 'Metronome off (M)';
    els.loopToggle.title = L.enabled ? 'Loop on: bars ' + L.startMeasure + '–' + L.endMeasure : 'Loop off';
    if (document.activeElement !== els.idea) els.idea.value = p.idea || '';
    undoUi();
  }
  function renderDrawer() {
    var p = project(), tr = track();
    els.projectSelect.textContent = '';
    lib.projects.slice().sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); }).forEach(function (pr) {
      var o = document.createElement('option'); o.value = pr.id; o.textContent = pr.title || 'Untitled project'; els.projectSelect.appendChild(o);
    });
    els.projectSelect.value = p.id;
    if (document.activeElement !== els.title) els.title.value = p.title;
    if (document.activeElement !== els.trackName) els.trackName.value = tr.name;
    var custom = tr.tuning.id === 'custom' || !M.TUNING_BY_ID[tr.tuning.id];
    var co = els.tuning.querySelector('option[value="custom"]');
    if (custom && !co) { co = document.createElement('option'); co.value = 'custom'; els.tuning.appendChild(co); }
    if (co) { co.textContent = M.CUSTOM.name + ': ' + M.tuningLabels(tr.tuning).slice().reverse().join(' '); co.hidden = !custom; co.disabled = !custom; }
    els.tuning.value = custom ? 'custom' : tr.tuning.id;
    els.timesig.value = p.timeSignature.join('/');
    var L = p.loop;
    els.loopInfo.textContent = (L.enabled ? 'Loop on' : 'Loop off') + ' · bars ' + L.startMeasure + '–' + L.endMeasure + ' of ' + M.measureCount(p);
    els.songInfo.textContent = 'Editing ' + (tr.name || 'track') + ' · cursor ' + posLabel(cell().start) + ' · grid ' + gridFrac(grid()) + ' · ' + M.measureCount(p) + ' bars';
    if (drawerOpen) els.ascii.textContent = toAscii(16);
  }
  function setToggle(b, on) { b.classList.toggle('on', !!on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }

  // Plain-text tab at the project grid: one block per track, barlines at measures, and a length row.
  function toAscii(perLine) {
    var p = project(), lines = [];
    if (p.title) lines.push(p.title);
    lines.push(p.bpm + ' bpm · ' + p.timeSignature.join('/') + ' · grid ' + M.DUR_FRACTION[p.grid.value] + (p.loop.enabled ? ' · loop bars ' + p.loop.startMeasure + '-' + p.loop.endMeasure : ''));
    if (p.idea) lines.push('Notes: ' + p.idea);
    p.tracks.forEach(function (tr) {
      // each track is written on its own steps (its own style)
      var cl = cellsOf(tr), labels = M.tuningLabels(tr.tuning), w = Math.max.apply(null, labels.map(function (n) { return n.length; })), bk = buckets(tr, cl), info = groups(p, cl, bk);
      lines.push('');
      lines.push('[' + (tr.name || 'Track') + '] ' + (tr.tuning.name || '') + ' · ' + gridFrac(gridOf(tr)) + (tr.mute ? ' · muted' : '') + (tr.solo ? ' · solo' : ''));
      var perBar = cl.filter(function (c) { return c.measure === 1; }).length, bars = Math.max(1, Math.floor(perLine / perBar));
      var mc = M.measureCount(p);
      for (var m0 = 1; m0 <= mc; m0 += bars) {
        var rows = labels.map(function (n) { return (n + '    ').slice(0, w) + '|'; });
        var dur = new Array(w + 2).join(' ');
        var first = true;
        cl.forEach(function (c, ci) {
          if (c.measure < m0 || c.measure >= m0 + bars) return;
          var g = info[ci];
          if (g.barStart && !first) { rows = rows.map(function (r) { return r + '|'; }); dur += ' '; }
          first = false;
          var dl = g.onset ? g.len : '';
          var texts = []; for (var si = 0; si < M.STRINGS; si++) texts.push(cellText(bk[ci].filter(function (n) { return n.string === si + 1; })[0]));
          var cw = Math.max(dl.length, Math.max.apply(null, texts.map(function (t) { return t.length; })), 1);
          rows = rows.map(function (r, si) { return r + '-' + texts[si] + new Array(cw - texts[si].length + 1).join('-'); });
          dur += ' ' + dl + new Array(cw - dl.length + 1).join(' ');
        });
        lines.push(rows.map(function (r) { return r + '-|'; }).join('\n'));
        lines.push(dur.replace(/\s+$/, ''));
      }
    });
    return lines.join('\n') + '\n';
  }

  function renderPicker() {
    var tr = track(), labels = M.tuningLabels(tr.tuning), c = cell(), mine = notesOn(tr, c, cur.str + 1), ev = mine[0] || null;
    els.pickerSub.textContent = (tr.name || 'Track') + ' · ' + posLabel(c.start) + ' · ' + labels[cur.str] + ' string (' + (cur.str + 1) + ')';
    Array.prototype.forEach.call(els.pickerStrings.children, function (b) {
      var i = Number(b.dataset.str);
      b.innerHTML = '<b></b><small></small>';
      b.firstChild.textContent = labels[i];
      b.lastChild.textContent = i === 0 ? '1 high' : i === M.STRINGS - 1 ? '6 low' : String(i + 1);
      b.setAttribute('aria-label', 'String ' + (i + 1) + ', ' + labels[i] + (i === 0 ? ', highest' : i === M.STRINGS - 1 ? ', lowest' : ''));
      b.classList.toggle('on', i === cur.str); b.setAttribute('aria-checked', i === cur.str ? 'true' : 'false');
      b.classList.toggle('has', notesOn(tr, c, i + 1).length > 0);
    });
    Array.prototype.forEach.call(els.neck.children, function (b) {
      var on = !!ev && ev.fret === Number(b.dataset.fret); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var mOn = !!ev && ev.fret === null;
    els.pickMute.classList.toggle('on', mOn); els.pickMute.setAttribute('aria-pressed', mOn ? 'true' : 'false');
    els.pickMute.textContent = mOn ? 'x Muted ✓' : 'x Muted';
    var tip = ev ? 'Tap the lit ' + (ev.fret === null ? 'Muted button' : 'fret') + ' again to remove it.' : 'Tap a fret to place a note.';
    if (ev && ev.startTick !== c.start) tip += ' This note is off the grid (at ' + posLabel(ev.startTick) + '); editing keeps its timing.';
    els.pickerTip.textContent = tip;
    els.pickerGrid.textContent = 'Grid ' + gridFrac(grid()) + ' · Next = 1 step';
    els.pickerUndo.disabled = els.undoBtn.disabled; els.pickerRedo.disabled = els.redoBtn.disabled;
    renderRoll();
    fitPicker();
  }
  // Mini tab roll inside the picker: the current bar on all six strings (high e on top, like the main roll).
  // Armed track in full, other tracks faint in their colours, the current step lit and the selected string in yellow.
  // pv (chord preview): { cellIndex: { stringIndex: text } } drawn in yellow over the bar, into the chord sheet's roll.
  function renderRoll(pv, roll, barEl) {
    roll = roll || els.pickerRoll; barEl = barEl || els.rollBar;
    var p = project(), tr = track(), ti = tindex(tr), labels = M.tuningLabels(tr.tuning), c = cell(), m = c.measure, ph = shownPh();
    var all = []; CL.forEach(function (x, i) { if (x.measure === m) all.push(i); });
    // Fine grids (1/32, 1/64, small triplets) have more steps per bar than fit legibly: show a window of up to
    // ROLL_MAX steps (whole pages of the bar) holding the current step, and say which steps are shown.
    var pos = all.indexOf(cur.cell), page = Math.floor(Math.max(0, pos) / ROLL_MAX), idx = all.slice(page * ROLL_MAX, page * ROLL_MAX + ROLL_MAX);
    var bt = M.beatTicks(p), first = idx[0], last = idx[idx.length - 1];
    var BK = p.tracks.map(function (t) {
      var b = {}; t.notes.forEach(function (n) { var k = M.cellIndexAt(CL, n.startTick); if (k >= first && k <= last) (b[k] = b[k] || []).push(n); }); return b;
    });
    var frag = document.createDocumentFragment();
    roll.className = 'roll tc' + ti; roll.style.setProperty('--rc', idx.length);
    for (var si = 0; si < M.STRINGS; si++) {
      var lab = document.createElement('div'); lab.className = 'rl' + (si === cur.str ? ' sel' : ''); lab.textContent = labels[si]; frag.appendChild(lab);
      idx.forEach(function (ci) {
        var d = document.createElement('div'), mine = (BK[ti][ci] || []).filter(function (n) { return n.string === si + 1; })[0], gh = null, gk = 0;
        var pt = pv && pv[ci] ? pv[ci][si] : undefined;
        if (pt !== undefined) { d.className = 'rc pv' + (ci === cur.cell ? ' now' : ''); var pb = document.createElement('b'); pb.textContent = pt; d.appendChild(pb); frag.appendChild(d); return; }
        if (!mine) BK.forEach(function (b, k) { if (k !== ti && !gh) { var n = (b[ci] || []).filter(function (x) { return x.string === si + 1; })[0]; if (n) { gh = n; gk = k; } } });
        d.className = 'rc' + (ci === cur.cell ? ' now' : '') + (si === cur.str ? ' sel' : '') + ((CL[ci].start - (m - 1) * M.measureTicks(p)) % bt === 0 && ci !== first ? ' bt' : '') + (idx.length > 12 ? ' fine' : '') +
          (ci === ph ? ' ph' : '') + (mine ? ' has' : gh ? ' gh g' + gk : '') + (pv && pv[ci] ? ' pv' : '');
        d.dataset.col = ci; d.dataset.str = si;
        if (mine) { var b = document.createElement('b'); b.textContent = cellText(mine); d.appendChild(b); } else if (gh) d.textContent = cellText(gh);
        frag.appendChild(d);
      });
    }
    roll.textContent = ''; roll.appendChild(frag);
    barEl.textContent = 'Bar ' + m + ' of ' + M.measureCount(p) + ' · step ' + (pos + 1) + '/' + all.length +
      (all.length > idx.length ? ' · showing ' + (page * ROLL_MAX + 1) + '–' + (page * ROLL_MAX + idx.length) : '');
  }
  var ROLL_MAX = 16;
  // Shrink the position readout's font (down to 9px) when the label is wider than its slot (narrow phones, fine grids).
  function fitPos() {
    var el = els.phInfo; el.style.fontSize = '';
    if (!el.clientWidth) return;
    var fs = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > el.clientWidth && fs > 9) { fs -= 0.5; el.style.fontSize = fs + 'px'; }
  }
  // Size the fret rows (and, if needed, the string chips) so the whole picker fits the visible screen without scrolling.
  function fitPicker() {
    var sh = els.picker, body = sh.querySelector('.picker-body'), side = sh.querySelector('.picker-side');
    var vh = Math.floor((window.visualViewport ? window.visualViewport.height : window.innerHeight) * 0.94);
    sh.style.setProperty('--frow', '20px'); sh.style.setProperty('--chip', '42px'); sh.classList.remove('tight');
    var other = sh.scrollHeight - body.offsetHeight, avail = vh - other - 1;
    var over = side.scrollHeight - avail;
    if (over > 0) sh.style.setProperty('--chip', Math.max(30, 42 - Math.ceil(over / 6)) + 'px');
    // Short screens: tighten the side column (smaller gaps and buttons), then let the string chips go down to 26px.
    if (side.scrollHeight > avail) {
      sh.classList.add('tight'); sh.style.setProperty('--chip', '30px');
      over = side.scrollHeight - avail;
      if (over > 0) sh.style.setProperty('--chip', Math.max(26, 30 - Math.ceil(over / 6)) + 'px');
    }
    // 23 rows: shrink them down to FROW_MIN. If they still don't fit (short screens), keep FROW_MIN rows and let only
    // the neck scroll inside the sheet, so tap targets stay usable; the sheet itself never scrolls.
    var rows = M.MAX_FRET + 1, fr = Math.floor((avail - 2) / rows), scroll = fr < FROW_MIN;
    sh.style.setProperty('--frow', (scroll ? FROW_MIN : Math.min(38, fr)) + 'px');
    sh.style.setProperty('--neckh', scroll ? Math.max(FROW_MIN * 6, avail - 2) + 'px' : 'none');
    els.neck.classList.toggle('scrolls', scroll);
    keepFretInView();
  }
  var FROW_MIN = 24;
  // When the neck scrolls, keep the placed fret in view (with none placed, leave the scroll where it is).
  function keepFretInView() {
    var nk = els.neck; if (nk.scrollHeight <= nk.clientHeight + 1) { nk.scrollTop = 0; return; }
    var on = nk.querySelector('.frow.on'); if (!on) return;
    var top = on.offsetTop, h = on.offsetHeight, pad = h;
    if (top - pad < nk.scrollTop) nk.scrollTop = Math.max(0, top - pad);
    else if (top + h + pad > nk.scrollTop + nk.clientHeight) nk.scrollTop = top + h + pad - nk.clientHeight;
  }

  var lastKey = null;
  function render() {
    renderTop();
    renderTracks();
    renderEditor();
    renderDrawer();
    if (pickerOpen) renderPicker();
    var key = project().id;
    if (key !== lastKey) { lastKey = key; els.editorWrap.scrollLeft = 0; scrollToCur(); }
  }

  function buildStatic() {
    M.TUNINGS.forEach(function (t) { var o = document.createElement('option'); o.value = t.id; o.textContent = t.name; els.tuning.appendChild(o); });
    M.DUR_VALUES.forEach(function (v) {
      var o = document.createElement('option'); o.value = v; o.textContent = M.DUR_FRACTION[v]; o.title = M.DUR_NAME[v]; els.gridSelect.appendChild(o);
    });
    for (var s = 0; s < M.STRINGS; s++) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.dataset.str = s; b.setAttribute('role', 'radio');
      els.pickerStrings.appendChild(b);
    }
    // Vertical neck: open string above the nut, then frets 1..MAX_FRET (22) going down, inlays on the fretboard.
    for (var f = 0; f <= M.MAX_FRET; f++) {
      var fb = document.createElement('button');
      fb.type = 'button'; fb.dataset.fret = f;
      fb.className = 'frow' + (f === 0 ? ' open' : '') + (INLAYS[f] ? ' inlay' : '');
      var dots = ''; for (var d = 0; d < (INLAYS[f] || 0); d++) dots += '<i></i>';
      fb.innerHTML = '<span class="n">' + f + '</span><span class="board"><span class="dots" aria-hidden="true">' + dots + '</span></span>';
      fb.setAttribute('aria-label', f === 0 ? 'Open string, 0' : 'Fret ' + f + (INLAYS[f] === 2 ? ', double dot' : INLAYS[f] ? ', dot' : ''));
      els.neck.appendChild(fb);
    }
  }

  // ---------- editing ----------
  // The picker edits the armed track's note on this string in the current grid step. Tapping the value
  // already there (same fret, or Muted when muted) removes it.
  function setEvent(fret, muted, noToggle) {
    var tr = track(), c = cell(), no = cur.str + 1, mine = notesOn(tr, c, no), had = mine[0] || null;
    if (fret === undefined) {
      tr.notes = tr.notes.filter(function (n) { return mine.indexOf(n) < 0; });
    } else if (had && !noToggle && (muted ? had.fret === null : had.fret === fret)) {
      tr.notes.splice(tr.notes.indexOf(had), 1);
      toast((muted ? 'Mute' : 'Fret ' + fret) + ' removed');
    } else {
      var tech = had ? had.techniques.filter(function (t) { return t !== 'muted'; }) : [];
      if (muted) tech.push('muted');
      if (had) { had.fret = muted ? null : fret; had.techniques = tech; }
      else {
        if (tr.notes.length >= M.LIMITS.notes) { toast('Track is full'); return; }
        tr.notes.push({ string: no, fret: muted ? null : fret, startTick: c.start, durationTicks: 0, techniques: tech });
      }
      A.preview(tr.tuning.midi[cur.str] + (muted ? 0 : fret), muted, M.trackTone(tr));
    }
    changed();
  }
  // Grid value (dropdown, whole project) and the armed track's style (Dotted / Triplet toggles). The step under
  // the cursor (and the playhead, if playing) stays on the same tick.
  function setGrid(value, style) {
    var p = project(), tr = track(), styleChange = style != null && style !== M.trackStyle(tr);
    var after = keepTick(function () {
      if (value != null) p.grid = { value: M.makeGrid(value).value };
      if (style != null) tr.style = style;
    });
    changed({ scroll: true });
    after();
    var gd = grid();
    toast(styleChange ? (tr.name || 'Track') + ': ' + (style === 'plain' ? 'straight' : style) + ' · ' + gridFrac(gd) : 'Grid ' + gridFrac(gd) + ' · ' + M.gridName(gd));
  }
  // Tapping a style turns it on (and the other off); tapping the active one goes back to plain.
  function toggleStyle(style) { setGrid(null, M.gridStyle(grid()) === style ? 'plain' : style); }
  function stepGridValue(dlt) {
    var i = M.DUR_VALUES.indexOf(grid().value) + dlt;
    if (i >= 0 && i < M.DUR_VALUES.length) setGrid(M.DUR_VALUES[i]);
  }
  function moveStep(dlt) {
    cur.cell += dlt; clampCur();
    if (!A.isPlaying()) { playheads[project().id] = cell().start; savePlayheads(); }
    render(); scrollToCur();
  }
  // Bar jumps: back goes to the start of this bar (or the previous bar if already there); forward goes to the next bar,
  // adding one at the end of the song like Next step does.
  function prevBar() {
    var m = cell().measure, start = firstOf(m);
    if (cur.cell === start && m > 1) start = firstOf(m - 1);
    moveStep(start - cur.cell);
  }
  function nextBar() {
    var p = project(), m = cell().measure;
    if (m === M.measureCount(p)) {
      if (M.measureCount(p) >= M.LIMITS.measures) { toast('Song is at the bar limit'); return; }
      p.lengthTicks += M.measureTicks(p); M.recompute(p); CL = cellsOf(); checkpoint(); save();
    }
    moveStep(firstOf(m + 1) - cur.cell);
  }
  function firstOf(m) { for (var i = 0; i < CL.length; i++) if (CL[i].measure === m) return i; return cur.cell; }
  function nextStep() {
    var p = project();
    if (cur.cell === CL.length - 1 && M.measureCount(p) < M.LIMITS.measures) { p.lengthTicks += M.measureTicks(p); M.recompute(p); CL = cellsOf(); checkpoint(); save(); }
    moveStep(1);
  }
  function scrollToCur(idx) {
    var col = els.editor.children[(idx == null ? cur.cell : idx) + 1];
    if (!col) return;
    var wrap = els.editorWrap, labelsW = els.editor.children[0] ? els.editor.children[0].offsetWidth : 40, left = col.offsetLeft - labelsW - 4, right = col.offsetLeft + col.offsetWidth;
    if (left < wrap.scrollLeft) wrap.scrollLeft = left;
    else if (right > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = right - wrap.clientWidth + 8;
  }
  function openPicker(col, str) {
    cur.cell = col; cur.str = str; pickerOpen = true;
    if (!A.isPlaying()) { playheads[project().id] = CL[col].start; savePlayheads(); }
    els.picker.hidden = false; els.scrim.hidden = false;
    render(); scrollToCur();
  }
  function closePicker() {
    pickerOpen = false; els.picker.hidden = true; els.scrim.hidden = true; render();
    var b = els.editor.querySelector('.cell[data-col="' + cur.cell + '"][data-str="' + cur.str + '"]');
    if (b) b.focus({ preventScroll: true });
  }
  function openDrawer() { drawerOpen = true; els.drawer.hidden = false; els.drawerScrim.hidden = false; els.menuBtn.setAttribute('aria-expanded', 'true'); renderDrawer(); }
  function closeDrawer() { drawerOpen = false; els.drawer.hidden = true; els.drawerScrim.hidden = true; els.menuBtn.setAttribute('aria-expanded', 'false'); }

  // ---------- playback / transport ----------
  // Walks the song one grid step at a time and layers every audible track (mute/solo/volume read live,
  // so mixer moves apply within ~150 ms). Each note sounds at its own startTick for its durationTicks.
  // Metronome (v8.2): the beat ticks inside a step, from the project time signature (one click per beat, the same
  // beat as the ruler: a quarter in 4/4, 3/4, 2/4, a dotted quarter in 6/8; accent on beat 1). Read live on every
  // step, so toggling, BPM changes and loops stay in sync.
  function clicksIn(p, start, len) {
    var bt = M.beatTicks(p), bar = M.measureTicks(p), out = [];
    for (var t = Math.ceil(start / bt) * bt; t < start + len; t += bt) out.push({ offset: t - start, tick: t, accent: t % bar === 0 });
    return out;
  }
  // v9: playback waits for the Sounds it needs (Play shows a small loading state); never a synth stand-in.
  function startPlayback(from, opts) {
    var p = project(), need = [];
    p.tracks.forEach(function (t) { var id = M.trackTone(t); if (need.indexOf(id) < 0) need.push(id); });
    if (!need.every(function (id) { return A.isReady(id); })) {
      A.stop(); if (playWait) playWait.cancel = true;
      var w = playWait = { cancel: false };
      if (!tonesAllowed) startTones();
      A.unlock(); playingStep = null; playProject = null; transportUi(); markPlaying();
      A.whenReady(need).then(function (res) {
        if (w.cancel) return; playWait = null;
        res.failed.forEach(toneFailed);
        if (project() !== p) { transportUi(); return; }
        // the steps may have changed while we waited (edits are allowed): clamp
        startNow(Math.min(from, CL.length - 1), opts);
      }, function () {
        if (w.cancel) return; playWait = null; transportUi();
        toast("Couldn't load the guitar sound. Check your connection, then press Play again.");
      });
      return;
    }
    startNow(from, opts);
  }
  function startNow(from, opts) {
    var p = project(), cl = CL, lp = loopCells(p, cl), n = cl.length;
    from = Math.max(0, Math.min(n - 1, from));
    var base, count, loop;
    if (lp) {
      if (from < lp.a || from > lp.b) from = lp.a;
      base = lp.a; count = lp.b - lp.a + 1; loop = true;
    } else { base = 0; count = n; loop = false; }
    A.stop();
    var ok = A.play({
      count: count, startAt: from - base, loop: loop, ppq: M.PPQ,
      bpm: function () { return p.bpm; },
      stepAt: function (i) {
        var c = cl[base + i], notes = [];
        if (!c) return { ticks: M.PPQ, notes: notes };
        M.audibleTracks(p).forEach(function (t) {
          var ti = p.tracks.indexOf(t);
          notesIn(t, c).forEach(function (e) {
            notes.push({ midi: t.tuning.midi[e.string - 1] + (e.fret || 0), muted: e.fret === null, offset: e.startTick - c.start, ticks: e.durationTicks, gain: t.volume / 100, track: ti, tone: M.trackTone(t) });
          });
        });
        return { ticks: c.len, notes: notes, clicks: p.metronome ? clicksIn(p, c.start, c.len) : null };
      },
      countIn: opts && opts.countIn && p.metronome ? { beats: Math.round(M.measureTicks(p) / M.beatTicks(p)), beatTicks: M.beatTicks(p) } : null,
      onStep: function (i) {
        if (i === null) { // reached the end with the loop off: back to the top, ready to play again
          playingStep = null; playProject = null; playheads[p.id] = 0; savePlayheads();
          transportUi(); markPlaying(); return;
        }
        playingStep = base + i;
        playheads[p.id] = cl[playingStep] ? cl[playingStep].start : 0;
        if (project() === p) { markPlaying(); scrollToCur(playingStep); }
      }
    });
    if (!ok) { toast('Audio is not available in this browser'); return; }
    playingStep = from; playProject = p.id; playheads[p.id] = cl[from].start;
    transportUi(); markPlaying();
  }
  function playPause() { if (A.isPlaying() || playWait) stopPlay(); else startPlayback(phCell(), { countIn: true }); }
  function startCell() { var lp = loopCells(project(), CL); return lp ? lp.a : 0; }
  // Back to start: jumps to the loop start (loop on) or bar 1; keeps playing if playing.
  function backToStart() { if (A.isPlaying()) startPlayback(startCell()); else { setPlayhead(startCell()); toast('Back to start'); } }
  // Stop (and Pause) keep the playhead where it stopped; Stop while already stopped returns to the start.
  function stopPlay(opts) {
    var was = A.isPlaying();
    if (playWait) { playWait.cancel = true; playWait = null; was = true; }
    A.stop();
    if (was) savePlayheads();
    else if (opts && opts.user) { setPlayhead(startCell()); toast('Back to start'); }
    playingStep = null; playProject = null; transportUi(); markPlaying(); markPlayhead();
  }
  function transportUi() {
    var on = A.isPlaying(), wait = !!playWait && !on;
    els.playBtn.classList.toggle('on', on);
    els.playBtn.classList.toggle('loading', wait);
    els.playBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    els.playBtn.setAttribute('aria-busy', wait ? 'true' : 'false');
    els.playBtn.setAttribute('aria-label', wait ? 'Loading sound… (press to cancel)' : on ? 'Pause' : 'Play');
    els.playBtn.title = wait ? 'Loading sound…' : on ? 'Pause (Space)' : 'Play (Space)';
  }
  function markPlaying() {
    var mine = playProject === project().id;
    Array.prototype.forEach.call(els.editor.children, function (c, k) { if (k) c.classList.toggle('playing', mine && k - 1 === playingStep); });
    markPlayhead();
  }
  function restartIfPlaying() { if (A.isPlaying() && playProject === project().id) startPlayback(playingStep); }

  // Ruler: bottom lane tap = move the playhead, drag = scrub (draggable playhead line).
  // Top lane (bar numbers) drag = draw or resize the loop brace; drag from a brace end to move that end.
  function bindRuler() {
    var rw = els.rulerWrap, drag = null;
    function stepAtX(x) {
      var cols = els.ruler.children, best = 0;
      for (var k = 1; k < cols.length; k++) { var r = cols[k].getBoundingClientRect(); if (x >= r.left && x < r.right) return k - 1; if (x >= r.left) best = k - 1; }
      return best;
    }
    function commit(i) {
      if (A.isPlaying()) {
        var lp = loopCells(project(), CL);
        if (lp && (i < lp.a || i > lp.b)) toast('Loop is on: jumped to the loop start');
        startPlayback(i);
      } else setPlayhead(i, { noScroll: true });
    }
    function applyLoop(m) {
      var L = project().loop, a = drag.anchor;
      if (drag.edge === 'start') L.startMeasure = Math.min(m, L.endMeasure);
      else if (drag.edge === 'end') L.endMeasure = Math.max(m, L.startMeasure);
      else { L.startMeasure = Math.min(a, m); L.endMeasure = Math.max(a, m); }
      L.enabled = true;
      renderEditor(); renderTop();
    }
    rw.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      var top = rw.getBoundingClientRect().top, i = stepAtX(e.clientX);
      drag = { id: e.pointerId, x0: e.clientX, moved: false, i: i, lane: e.clientY - top < 24 ? 'loop' : 'ph' };
      if (drag.lane === 'loop' && CL[i]) {
        var L = project().loop, m = CL[i].measure;
        drag.orig = JSON.stringify(L);
        drag.edge = L.enabled && m === L.startMeasure && m !== L.endMeasure ? 'start' : L.enabled && m === L.endMeasure && m !== L.startMeasure ? 'end' : 'new';
        drag.anchor = drag.edge === 'new' && L.enabled && m === L.startMeasure ? L.startMeasure : m;
      }
      try { rw.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
    });
    rw.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved && Math.abs(e.clientX - drag.x0) < 8) return;
      drag.moved = true;
      var r = rw.getBoundingClientRect();
      if (e.clientX < r.left + 70) els.editorWrap.scrollLeft -= 12; else if (e.clientX > r.right - 30) els.editorWrap.scrollLeft += 12;
      drag.i = stepAtX(e.clientX);
      if (drag.lane === 'loop' && CL[drag.i]) applyLoop(CL[drag.i].measure); else markPlayhead(drag.i);
      e.preventDefault();
    });
    function end(e) {
      if (!drag || e.pointerId !== drag.id) return;
      var d = drag; drag = null;
      if (e.type === 'pointercancel') { if (d.orig) { var o = JSON.parse(d.orig), L = project().loop; L.enabled = o.enabled; L.startMeasure = o.startMeasure; L.endMeasure = o.endMeasure; render(); } else markPlayhead(); return; }
      if (d.lane === 'loop' && d.moved) {
        var L2 = project().loop; changed(); restartIfPlaying();
        toast('Loop bars ' + L2.startMeasure + (L2.endMeasure !== L2.startMeasure ? '–' + L2.endMeasure : ''));
        return;
      }
      commit(d.moved ? d.i : stepAtX(e.clientX));
    }
    rw.addEventListener('pointerup', end); rw.addEventListener('pointercancel', end);
    rw.addEventListener('click', function (e) { if (e.detail === 0) { var b = e.target.closest('.rcol'); if (b) commit(Number(b.dataset.step)); } });
    rw.addEventListener('wheel', function (e) { els.editorWrap.scrollLeft += (e.deltaX || e.deltaY); e.preventDefault(); }, { passive: false });
    els.editorWrap.addEventListener('scroll', function () { rw.scrollLeft = els.editorWrap.scrollLeft; }, { passive: true });
  }

  // ---------- chord library ----------
  // Opened from the step editor. Shapes come from chords.json (precached by the service worker); names are worked out
  // against the armed track's tuning (TabChords.label). Boxes, fret codes and the detail's full neck all read like a
  // chord chart: low E on the left (since v8.2). Finger numbers are not drawn (v8.2). Power and barre
  // chords are movable (TabChords.make): the detail has a root-string toggle and a ‹ fret › stepper, CH.mv.
  var C = window.TabChords, CH = { data: null, list: null, listKey: '', loading: null, open: false, fam: 'all', q: '', sel: null, mv: null, mode: 'strum' };
  var CFAMS = [['all', 'All'], ['open', 'Open'], ['power', 'Power'], ['barre', 'Barre'], ['other', 'Other']];
  var CFAM_HEAD = { open: 'Open chords', power: 'Power chords', barre: 'Barre chords', other: 'Other' };
  function loadChords() {
    if (CH.data) return Promise.resolve(refreshChordList());
    if (!CH.loading) CH.loading = fetch('chords.json').then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { CH.data = d; refreshChordList(); return CH.list; }).catch(function (e) { CH.loading = null; throw e; });
    return CH.loading;
  }
  function chordStep() { var c = cell(), m = c.measure, f = firstOf(m), n = 0; CL.forEach(function (x) { if (x.measure === m) n++; }); return { bar: m, step: cur.cell - f + 1, of: n }; }
  function chordSub() { var tr = track(), st = chordStep(); return (tr.name || 'Track') + ' · ' + (TUNING_SHORT[tr.tuning.id] || 'Custom') + ' · Bar ' + st.bar + ' · step ' + st.step + '/' + st.of; }
  function openChords() {
    if (!pickerOpen) return;
    loadChords().then(function () {
      CH.open = true; CH.sel = null; CH.mv = null; CH.q = ''; $('chords-q').value = ''; els.toast.hidden = true;
      $('chords').hidden = false; $('chords-scrim').hidden = false; els.chordsOpen.classList.add('on');
      renderChords(); $('chords-list').scrollTop = 0; $('chords-q').focus({ preventScroll: true });
    }).catch(function () { toast("Couldn't load the chord library. Check your connection and try again."); });
  }
  function closeChords() {
    CH.open = false; CH.sel = null; CH.mv = null; $('chords').hidden = true; $('chords-scrim').hidden = true; els.chordsOpen.classList.remove('on');
    if (pickerOpen) { renderPicker(); els.chordsOpen.focus({ preventScroll: true }); }
  }
  // The card list for the armed track's tuning (movable shapes are rebuilt when the tuning changes).
  function refreshChordList() {
    var midi = track().tuning.midi, key = midi.join();
    if (CH.data && CH.listKey !== key) { CH.list = C.expand(CH.data, midi); CH.listKey = key; }
    return CH.list;
  }
  function chordById(id) { return (CH.list || []).filter(function (c) { return c.id === id; })[0] || null; }
  // The chord in the detail view: a card as is, or a movable shape at the stepper's fret.
  function selChord() {
    if (!CH.sel) return null;
    if (CH.mv) return C.make(CH.mv.shape, CH.mv.r, track().tuning.midi, CH.mv.n, CH.sel);
    return chordById(CH.sel);
  }
  function lowLabels(tr) { return M.tuningLabels(tr.tuning).slice().reverse(); } // low E first, for chord boxes
  function renderChords() {
    refreshChordList();
    var tr = track(), midi = tr.tuning.midi, sh = $('chords'), detail = !!CH.sel, labs = lowLabels(tr);
    $('chords-sub').textContent = chordSub();
    sh.classList.toggle('detail', detail);
    var found = C.search(CH.list, CH.q, midi), counts = {};
    found.forEach(function (c) { counts[c.family] = (counts[c.family] || 0) + 1; });
    var fam = $('chords-fam'); fam.textContent = '';
    CFAMS.forEach(function (f) {
      var b = document.createElement('button'), n = f[0] === 'all' ? found.length : counts[f[0]] || 0;
      b.type = 'button'; b.className = 'chip' + (CH.fam === f[0] ? ' on' : ''); b.dataset.fam = f[0]; b.setAttribute('aria-pressed', CH.fam === f[0] ? 'true' : 'false');
      b.textContent = f[1] + ' '; var sm = document.createElement('small'); sm.textContent = n; b.appendChild(sm); fam.appendChild(b);
    });
    var list = $('chords-list'), html = '', any = false;
    ['open', 'power', 'barre', 'other'].forEach(function (k) {
      if (CH.fam !== 'all' && CH.fam !== k) return;
      var l = found.filter(function (c) { return c.family === k; }); if (!l.length) return; any = true;
      html += '<h3 class="cgh"><span class="sec-lab">' + CFAM_HEAD[k] + '</span><small>' + l.length + '</small></h3><div class="cgrid">';
      l.forEach(function (c) {
        var lb = C.label(c, midi), sel = CH.sel === c.id;
        html += '<button type="button" class="ccard' + (sel ? ' sel' : '') + (c.movable ? ' mv' : '') + '" data-id="' + esc(c.id) + '" aria-label="' + esc(lb.text + ', ' + C.QUALITY_LONG[c.quality] + (c.movable ? ', movable, ' + C.qualityLine(c) : '') + ', frets low E to high e: ' + C.codeFull(c).split(c.frets.some(function (f) { return f > 9; }) ? '-' : '').join(' ')) + '"' + (sel ? ' aria-current="true"' : '') + '>' +
          '<span><span class="cn' + (lb.name.length > 5 ? ' long' : '') + '">' + esc(lb.name) + '</span><span class="cq">' + esc(lb.exact ? C.qualityLine(c) : lb.shift === null ? 'shape · ' + c.quality : c.name + ' shape · ' + c.quality) + '</span>' +
          '<span class="cf" title="Frets, low E to high e">' + esc(C.code(c)) + '</span></span>' + C.box(c, { sel: sel, labels: labs }) + (sel ? '<span class="tag">Preview</span>' : '') + '</button>';
      });
      html += '</div>';
    });
    list.innerHTML = any ? html : '<p class="cempty">No chords match "' + esc(CH.q) + '".</p>';
    var st = chordStep();
    $('chords-foot').textContent = 'Tap a chord to preview it at bar ' + st.bar + ' · step ' + st.step + '. Power and barre chords slide up the neck with \u2039 fret \u203a.';
    $('chords-detail').hidden = !detail;
    if (detail) renderChordDetail(); else sh.classList.remove('nolist');
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }
  // Where each note of the chord lands: strum = all at the cursor step; arp = one step apart, low string first.
  function chordPlan(c) {
    var ns = C.notes(c);
    return ns.map(function (n, k) { return { string: n.string, fret: n.fret, cell: CH.mode === 'arp' ? cur.cell + k : cur.cell }; });
  }
  function renderChordDetail() {
    var c = selChord(), tr = track(), midi = tr.tuning.midi, lb = C.label(c, midi), labels = M.tuningLabels(tr.tuning), mv = c.movable;
    $('cd-name').textContent = lb.name;
    $('cd-info').innerHTML = esc(lb.exact ? C.QUALITY_LONG[c.quality] : lb.shift === null ? C.QUALITY_LONG[c.quality] + ' shape' : c.name + ' shape') + ' · <em>' + esc(C.code(c)) + '</em>';
    var note = $('cd-note'); note.hidden = lb.exact; note.textContent = lb.exact ? '' : lb.note;
    // movable shapes: root string toggle, ‹ fret › stepper, 3 / 2 notes (power)
    $('cd-move').hidden = !mv;
    if (mv) {
      var pw = c.family === 'power';
      $('cd-s6').textContent = pw ? '6th' : 'E shape'; $('cd-s5').textContent = pw ? '5th' : 'A shape';
      $('cd-s6').setAttribute('aria-label', pw ? 'Root on the 6th string' : 'E shape: root on the 6th string');
      $('cd-s5').setAttribute('aria-label', pw ? 'Root on the 5th string' : 'A shape: root on the 5th string');
      $('cd-rootlab').textContent = pw ? 'Root' : '';
      setToggle($('cd-s6'), mv.string === 6); setToggle($('cd-s5'), mv.string === 5);
      $('cd-fret').textContent = 'fret ' + mv.r;
      $('cd-fret').setAttribute('aria-label', 'Root fret ' + mv.r + ' on the ' + (mv.string === 6 ? '6th' : '5th') + ' string');
      $('cd-down').disabled = mv.r <= mv.min; $('cd-up').disabled = mv.r >= mv.max;
      $('cd-ns').hidden = !pw;
      setToggle($('cd-n3'), mv.n !== 2); setToggle($('cd-n2'), mv.n === 2);
    }
    // preview roll: the planned notes in yellow over this bar (anything past this page/bar isn't shown)
    var pv = {}, plan = chordPlan(c), lastCell = CL.length - 1, beyond = 0;
    plan.forEach(function (n) { if (n.cell > lastCell || CL[n.cell].measure !== cell().measure) { beyond++; return; } (pv[n.cell] = pv[n.cell] || {})[n.string - 1] = String(n.fret); });
    renderRoll(pv, $('cd-roll'), $('cd-bar'));
    $('cd-cap').textContent = CH.mode === 'arp' ? 'Arp · ' + plan.length + ' steps' + (beyond ? ' (' + beyond + ' into the next bar)' : '') : 'Strum · ' + plan.length + ' notes stacked';
    $('cd-roll').className += ' cdroll';
    // full-neck header: low E on the left, like the chord boxes (labels follow the tuning: D A D G B e in drop D)
    var hs = '<span>fret</span>'; for (var si = M.STRINGS - 1; si >= 0; si--) hs += '<span>' + esc(labels[si]) + '</span>'; $('cd-str').innerHTML = hs;
    // string chips, low E first (same order as the neck, box and code)
    var chips = '';
    for (var i = 0; i < M.STRINGS; i++) {
      var v = c.frets[i], lab = labels[5 - i];
      chips += '<span class="chip' + (v > 0 ? ' fr' : v === null ? ' mu' : '') + '"><b>' + esc(lab) + '</b><small>' + (v === null ? 'muted' : v === 0 ? 'open' : 'fret ' + v) + '</small></span>';
    }
    $('cd-chips').innerHTML = chips;
    setToggle($('cd-strum'), CH.mode === 'strum'); setToggle($('cd-arp'), CH.mode === 'arp');
    $('cd-neck').setAttribute('aria-label', lb.text + ' on the neck, low E on the left. Frets low E to high e: ' + C.codeFull(c));
    fitChords();
  }
  // Neck rows: frets 0..rows-1, or (shapes high up the neck) the open-string row, then a window round the shape.
  function neckFrets(c, rows) {
    var fr = c.frets.filter(function (f) { return f > 0; }), maxF = fr.length ? Math.max.apply(null, fr) : 0, minF = fr.length ? Math.min.apply(null, fr) : 0, out = [0], k;
    if (maxF + 2 <= rows) { for (k = 1; k < rows; k++) out.push(k); return out; }
    var lo = Math.max(1, Math.min(minF - 1, M.MAX_FRET - (rows - 2)));
    if (maxF > lo + rows - 2) lo = maxF - (rows - 2);
    for (k = 0; k < rows - 1; k++) out.push(lo + k);
    return out;
  }
  function chordNeck(c, rows) {
    // columns low E -> high e (frets[] order), k0 = low E on the left; plain dots, no finger numbers
    var h = '', list = neckFrets(c, rows);
    list.forEach(function (f, ri) {
      var mk = '', hit = false;
      c.frets.forEach(function (v, i) {
        var col = ' k' + i; // column class (no inline styles: the CSP is style-src 'self')
        if (f === 0 && v === 0) mk += '<i class="mk o' + col + '"></i>';
        else if (f === 0 && v === null) mk += '<i class="mk x' + col + '">×</i>';
        else if (v === f && f > 0) { mk += '<i class="mk' + col + '"></i>'; hit = true; }
      });
      if (c.barre && c.barre.fret === f) mk = '<i class="mk barre" data-a="' + (c.barre.from - 1) + '" data-b="' + (c.barre.to - 1) + '"></i>' + mk;
      var dots = ''; for (var d = 0; d < (INLAYS[f] || 0); d++) dots += '<i></i>';
      h += '<div class="frow' + (f === 0 ? ' open' : '') + (ri === 1 && f > 1 ? ' gap' : '') + (INLAYS[f] ? ' inlay' : '') + (hit ? ' hit' : '') + '"><span class="n">' + f + '</span><span class="board"><span class="dots">' + dots + '</span>' + mk + '</span></div>';
    });
    $('cd-neck').innerHTML = h;
    // the barre bar spans columns a..b (low E first); set through CSSOM, which the CSP allows
    Array.prototype.forEach.call($('cd-neck').querySelectorAll('.mk.barre'), function (el) {
      var a = +el.dataset.a, b = +el.dataset.b;
      el.style.left = ((a + 0.5) / 6 * 100).toFixed(3) + '%'; el.style.width = ((b - a) / 6 * 100).toFixed(3) + '%';
    });
  }
  // Fit the detail view to the sheet without scrolling: keep the chord list band if there's room (else drop it), then
  // show as many neck rows as fit (at least frets 0..max(5, highest fret + 1)), shrinking rows from 22px to 16px.
  function fitChords() {
    var sh = $('chords'), body = sh.querySelector('.cbody'), side = sh.querySelector('.cside'), c = selChord();
    if (!c) return;
    var fr = c.frets.filter(function (f) { return f > 0; }), maxF = fr.length ? Math.max.apply(null, fr) : 0, minF = fr.length ? Math.min.apply(null, fr) : 0;
    var minRows = Math.max(6, Math.min(maxF + 2, maxF - minF + 4));
    function tryFit(withList) {
      sh.classList.toggle('nolist', !withList);
      body.style.setProperty('--cchip', '30px');
      chordNeck(c, minRows); body.style.setProperty('--frow', '16px');
      var free = sh.clientHeight - sh.scrollHeight + body.offsetHeight; // height the body may take
      if (side.offsetHeight > free) {
        body.style.setProperty('--cchip', Math.max(24, 30 - Math.ceil((side.offsetHeight - free) / 6)) + 'px');
        if (side.offsetHeight > free) return false;
      }
      var neckRoom = Math.max(free, side.offsetHeight) - 18, fr = Math.min(22, Math.floor(neckRoom / minRows));
      if (fr < 16) return false;
      var rows = Math.min(M.MAX_FRET + 1, Math.max(minRows, Math.floor(neckRoom / fr)));
      if (fr === 22) rows = Math.min(rows, Math.max(minRows, 13));
      chordNeck(c, rows); body.style.setProperty('--frow', fr + 'px');
      return sh.scrollHeight <= sh.clientHeight + 1;
    }
    if (!tryFit(true)) tryFit(false);
    var cardEl = $('chords-list').querySelector('.ccard.sel');
    if (cardEl && !sh.classList.contains('nolist')) $('chords-list').scrollTop = Math.max(0, cardEl.offsetTop - 40);
  }
  function previewChord(c) {
    if (!c) return;
    var tr = track(), ps = C.pitches(c, tr.tuning.midi), gap = CH.mode === 'arp' ? 170 : 28;
    var tn = M.trackTone(tr);
    ps.forEach(function (m, k) { if (!k) A.preview(m, false, tn); else setTimeout(function () { A.preview(m, false, tn); }, k * gap); });
  }
  function selectChord(id) {
    var c = chordById(id); if (!c) return;
    CH.sel = id; CH.mv = c.movable ? { shape: c.movable.shape, r: c.movable.r, n: c.movable.n } : null;
    renderChords(); previewChord(c);
  }
  // Movable shapes: slide the root fret, switch the root string (same root note), or 3 / 2 notes (power chords).
  function moveChord(fn) {
    if (!CH.mv) return;
    var midi = track().tuning.midi; fn(CH.mv, midi);
    var c = C.make(CH.mv.shape, CH.mv.r, midi, CH.mv.n); CH.mv.r = c.movable.r;
    if (c.family === 'power') { var card = 'P-' + c.name.slice(0, -1); if (chordById(card)) CH.sel = card; } // follow the root's card
    renderChords(); previewChord(selChord());
  }
  // Drop: up to six notes on the armed track at the cursor step (Arp: one step apart, low string first, adding bars
  // at the end of the song if needed). Muted (x) strings are skipped; notes already on the chord's strings in the
  // target step are replaced. One undo step.
  function dropChord() {
    var c = selChord(); if (!c) return;
    var p = project(), tr = track(), plan = chordPlan(c), lb = C.label(c, tr.tuning.midi), st = chordStep();
    var need = plan.length ? plan[plan.length - 1].cell : cur.cell;
    while (need > CL.length - 1 && M.measureCount(p) < M.LIMITS.measures) { p.lengthTicks += M.measureTicks(p); M.recompute(p); CL = cellsOf(); }
    var placed = 0, full = false;
    plan.forEach(function (n) {
      var cc = CL[Math.min(n.cell, CL.length - 1)];
      tr.notes = tr.notes.filter(function (x) { return !(x.string === n.string && x.startTick >= cc.start && x.startTick < cc.start + cc.len); });
      if (tr.notes.length >= M.LIMITS.notes) { full = true; return; }
      tr.notes.push({ string: n.string, fret: n.fret, startTick: cc.start, durationTicks: 0, techniques: [] });
      placed++;
    });
    var mode = CH.mode;
    closeChords();
    changed({ scroll: true });
    toast(lb.name + (mode === 'arp' ? ' arpeggio' : '') + ' added at bar ' + st.bar + ', step ' + st.step + (full ? ' (track full: ' + placed + ' notes)' : ''), { label: 'Undo', fn: undo });
  }
  function bindChords() {
    els.chordsOpen.addEventListener('click', openChords);
    on('chords-close', 'click', closeChords);
    on('chords-scrim', 'click', closeChords);
    on('chords-q', 'input', function () { CH.q = $('chords-q').value; renderChords(); $('chords-list').scrollTop = 0; });
    on('chords-fam', 'click', function (e) { var b = e.target.closest('.chip'); if (!b) return; CH.fam = b.dataset.fam; renderChords(); $('chords-list').scrollTop = 0; });
    on('chords-list', 'click', function (e) { var b = e.target.closest('.ccard'); if (b) selectChord(b.dataset.id); });
    on('cd-strum', 'click', function () { CH.mode = 'strum'; renderChordDetail(); previewChord(selChord()); });
    on('cd-arp', 'click', function () { CH.mode = 'arp'; renderChordDetail(); previewChord(selChord()); });
    on('cd-down', 'click', function () { moveChord(function (m) { m.r--; }); });
    on('cd-up', 'click', function () { moveChord(function (m) { m.r++; }); });
    function toString(n) { return function () { moveChord(function (m, midi) { var sh = C.SHAPES[m.shape]; if (sh.string === n) return; m.r = C.pairFret(m.shape, m.r, midi, m.n || 3); m.shape = sh.pair; }); }; }
    on('cd-s6', 'click', toString(6)); on('cd-s5', 'click', toString(5));
    on('cd-n3', 'click', function () { moveChord(function (m) { m.n = 3; }); });
    on('cd-n2', 'click', function () { moveChord(function (m) { m.n = 2; }); });
    on('cd-drop', 'click', dropChord);
    on('cd-cancel', 'click', function () { CH.sel = null; CH.mv = null; renderChords(); });
  }

  // ---------- modal + toast ----------
  // action: { label, fn } adds a button (e.g. Undo) and keeps the toast up longer.
  function toast(msg, action) {
    var t = els.toast; t.textContent = ''; t.className = 'toast' + (action ? ' act' : '');
    if (action) {
      var sp = document.createElement('span'); sp.textContent = msg; t.appendChild(sp);
      var b = document.createElement('button'); b.type = 'button'; b.textContent = action.label; b.id = 'toast-act';
      b.addEventListener('click', function () { t.hidden = true; action.fn(); });
      t.appendChild(b);
    } else t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, action ? 6000 : 2600);
  }
  function choose(title, body, buttons) {
    return new Promise(function (resolve) {
      els.modalH.textContent = title; els.modalBody.textContent = body; els.modalActions.textContent = '';
      buttons.forEach(function (b) {
        var el = document.createElement('button');
        el.type = 'button'; el.className = 'btn ' + (b.cls || ''); el.textContent = b.label; el.dataset.value = b.value;
        el.addEventListener('click', function () { els.modal.hidden = true; els.modalScrim.hidden = true; resolve(b.value); });
        els.modalActions.appendChild(el);
      });
      els.modal.hidden = false; els.modalScrim.hidden = false;
      els.modalActions.firstChild.focus();
    });
  }
  function showWarnings(w) {
    if (!w || !w.length) return;
    choose('Imported with changes', w.slice(0, 6).join('\n') + (w.length > 6 ? '\n…and ' + (w.length - 6) + ' more.' : ''), [{ label: 'OK', value: 0, cls: 'go' }]);
  }

  // ---------- export / import ----------
  function slug(s) { return (s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'tab'; }
  function stamp() { var d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()); }
  function fileFor(kind) {
    var projects = kind === 'library' ? lib.projects : [project()];
    var out = { schema: M.SCHEMA, schemaVersion: M.SCHEMA_VERSION, kind: kind, ppq: M.PPQ, exportedAt: M.nowIso(),
      activeProjectId: lib.activeProjectId, projects: projects };
    var name = (kind === 'library' ? 'guitar-tab-library' : slug(project().title)) + '-' + stamp() + '.json';
    return { name: name, blob: new Blob([JSON.stringify(out, null, 2) + '\n'], { type: 'application/json' }) };
  }
  // Saves the project as a .json file (your backup, and how you move it to another device).
  function exportJson(kind) {
    var f = fileFor(kind), url = URL.createObjectURL(f.blob), a = document.createElement('a');
    a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('Exported ' + f.name);
  }
  // MIDI (.mid): a small sheet with All tracks (one file, one lane per track) plus one row per track.
  // All tracks includes every track whatever its mute/solo (mixer kept as CC7 + a name note); a single track
  // exports on its own. Encoder: js/midi.js.
  function exportMidiSheet() {
    var p = project(), aud = M.audibleTracks(p);
    var btns = [{ label: 'All tracks (' + p.tracks.length + ') · one file', value: 'all', cls: 'go' }];
    p.tracks.forEach(function (t, i) {
      var st = t.mute ? ' · muted' : aud.indexOf(t) < 0 ? ' · not soloed' : t.solo ? ' · solo' : '';
      btns.push({ label: (i + 1) + '. ' + (t.name || 'Track') + ' · ' + (TUNING_SHORT[t.tuning.id] || t.tuning.name) + st, value: t.id, cls: 'trk-x c' + i });
    });
    btns.push({ label: 'Cancel', value: 'cancel' });
    choose('Export MIDI', 'All tracks: one .mid with each track on its own lane and channel (muted or unsoloed tracks are still included, at their mixer volume). Or pick one track for its own file.', btns)
      .then(function (v) { if (v !== 'cancel') exportMidi(v); });
  }
  function exportMidi(mode) {
    var p = project(), t = mode === 'all' ? null : p.tracks.filter(function (x) { return x.id === mode; })[0];
    var bytes = window.TabMidi.build(p, { mode: mode }), name = window.TabMidi.fileName(p, t);
    var url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' })), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('Exported ' + name);
  }
  // Share, falling back step by step: (1) the project file through the share sheet, (2) the tab as text through
  // the share sheet, (3) the tab text copied to the clipboard, (4) the .json file saved like Export.
  // v7 bug (Android Chrome/Brave): Chromium only shares files whose type is on its allowlist (text, images, PDF...);
  // application/json is not, yet canShare({files}) still said yes, so share() was refused and we only showed
  // "Share failed". The file now goes as text/plain named .json.txt (the same JSON inside; Import takes it).
  // Cancelling the share sheet (AbortError) ends the chain quietly. Each step that fails falls through to the next.
  var shareLog = [];
  function shareFileFor() {
    var f = fileFor('project');
    return new File([f.blob], f.name.replace(/\.json$/, '.json.txt'), { type: 'text/plain' });
  }
  function shareText() {
    var p = project(), title = p.title || 'Guitar tab';
    return { title: title, text: title + '\n\n' + toAscii(16) };
  }
  function canShare(data) { try { return !!(navigator.canShare && navigator.canShare(data)); } catch (e) { return false; } }
  function share() {
    var p = project(), title = p.title || 'Guitar tab', file = null, tx = shareText(), log = shareLog = [];
    var aborted = function (e) { return e && e.name === 'AbortError'; };
    function viaFile() {
      try { file = shareFileFor(); } catch (e) { file = null; }
      if (!navigator.share || !file || !canShare({ files: [file] })) { log.push('files:skip'); return Promise.reject({ skip: true }); }
      log.push('files');
      return navigator.share({ files: [file], title: title });
    }
    function viaText() {
      if (!navigator.share || (navigator.canShare && !canShare({ title: tx.title, text: tx.text }))) { log.push('text:skip'); return Promise.reject({ skip: true }); }
      log.push('text');
      return navigator.share({ title: tx.title, text: tx.text });
    }
    function viaClipboard() {
      if (!navigator.clipboard || !navigator.clipboard.writeText) { log.push('clipboard:skip'); return Promise.reject({ skip: true }); }
      log.push('clipboard');
      return navigator.clipboard.writeText(tx.text).then(function () { toast("Sharing isn't available here: tab copied as text"); });
    }
    function viaDownload() {
      log.push('download');
      var f = fileFor('project'), url = URL.createObjectURL(f.blob), a = document.createElement('a');
      a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast("Sharing isn't available here: saved " + f.name);
    }
    function note(stage) { return function (e) { if (aborted(e)) { log.push('abort'); throw e; } if (e && !e.skip) log.push(stage + ':fail:' + (e.name || 'Error')); }; }
    // the first share() call runs synchronously inside the tap, so it has the user activation
    var chain;
    try { chain = viaFile(); } catch (e0) { chain = Promise.reject(e0); }
    return chain.then(function () { log.push('done'); }, function (e) {
      note('files')(e);
      return viaText().then(function () { log.push('done'); }, function (e2) {
        note('text')(e2);
        return viaClipboard().then(function () { log.push('done'); }, function (e3) {
          note('clipboard')(e3);
          viaDownload(); log.push('done');
        });
      });
    }).catch(function (e) { if (!aborted(e)) { log.push('error'); toast('Share failed. Use Export instead.'); } });
  }
  function importFile(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast('That file is too big to be a tab.'); return; }
    var r = new FileReader();
    r.onload = function () {
      var obj;
      try { obj = JSON.parse(r.result); } catch (e) { choose('Import failed', 'That file is not valid JSON.', [{ label: 'OK', value: 0 }]); return; }
      var res = M.parseFile(obj);
      if (res.error) { choose('Import failed', res.error, [{ label: 'OK', value: 0 }]); return; }
      var n = res.projects.length, names = res.projects.slice(0, 3).map(function (p) { return '"' + (p.title || 'Untitled') + '"'; }).join(', ') + (n > 3 ? ' and ' + (n - 3) + ' more' : '');
      choose('Import ' + n + ' project' + (n > 1 ? 's' : ''), 'File has ' + names + '. Merge adds them to your library (a project you already have is kept, and a changed copy is added beside it). Replace deletes your current ' + lib.projects.length + ' project' + (lib.projects.length > 1 ? 's' : '') + ' first.',
        [{ label: 'Merge', value: 'merge', cls: 'go' }, { label: 'Replace all', value: 'replace', cls: 'warn' }, { label: 'Cancel', value: 'cancel' }])
        .then(function (choice) {
          if (choice === 'cancel') return;
          if (choice === 'replace') {
            if (!confirm('Replace your whole library with this file? This cannot be undone. Export all first if unsure.')) return;
            lib.projects = res.projects;
          } else {
            res.projects.forEach(function (p) {
              var have = lib.projects.filter(function (x) { return x.id === p.id; })[0];
              if (!have) { lib.projects.push(p); return; }
              if (snapOf(have) === snapOf(p)) return; // identical
              p.id = M.uid(); p.title = (p.title || 'Untitled') + ' (imported)'; lib.projects.push(p);
            });
            if (lib.projects.length > M.LIMITS.projects) lib.projects = lib.projects.slice(0, M.LIMITS.projects);
          }
          lib.activeProjectId = res.projects[0].id;
          hist = {};
          cur = { cell: 0, str: 0 }; stopPlay(); closeDrawer(); changed();
          toast((choice === 'merge' ? 'Merged ' : 'Replaced with ') + n + ' project' + (n > 1 ? 's' : ''));
          showWarnings(res.warnings);
        });
    };
    r.onerror = function () { toast('Could not read that file.'); };
    r.readAsText(file);
  }

  // ---------- BPM hold-to-accelerate ----------
  // A tap on + / − is exactly 1 BPM. Holding repeats 1-BPM steps after HOLD.delay ms, the gap between steps
  // shrinking geometrically, gap(n) = max(HOLD.min, HOLD.start * HOLD.decay^n), so it reaches the steady fast rate
  // about 1.5 s into the hold; 90 -> 150 takes about 3.3 s. Playback reads the BPM every step, so the tempo follows
  // live. The whole hold is one undo step and is saved once, on release.
  var BPM_MIN = 30, BPM_MAX = 300, HOLD = { delay: 400, start: 250, decay: 0.8, min: 36 };
  function clampBpm(v) { return Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(v) || 90)); }
  var hold = null, holdLog = [];
  function holdStep() {
    var p = project(), v = clampBpm(p.bpm + hold.dir);
    if (v === p.bpm) { endHold(); return false; }
    p.bpm = v; els.bpm.value = v; holdLog.push({ t: Math.round(performance.now() - hold.t0), bpm: v });
    if (v === BPM_MIN || v === BPM_MAX) { endHold(); return false; }
    return true;
  }
  function holdNext() {
    var gap = Math.max(HOLD.min, HOLD.start * Math.pow(HOLD.decay, hold.n++));
    hold.timer = setTimeout(function () { if (hold && holdStep()) holdNext(); }, gap);
  }
  function endHold() {
    if (!hold) return;
    clearTimeout(hold.timer); hold = null;
    checkpoint(); save();
  }
  function bindBpmHold(btn, dir) {
    btn.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault(); // no text selection / focus steal / ghost click
      endHold();
      hold = { dir: dir, n: 0, t0: performance.now(), timer: null }; holdLog = [{ t: 0, bpm: project().bpm }];
      if (holdStep()) hold.timer = setTimeout(function () { if (hold && holdStep()) holdNext(); }, HOLD.delay);
    });
    ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture'].forEach(function (ev) { btn.addEventListener(ev, endHold); });
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    // Keyboard (Enter / Space on the focused button) still steps 1; pointer clicks were already handled on pointerdown.
    btn.addEventListener('click', function (e) { if (e.detail === 0) { var p = project(); p.bpm = clampBpm(p.bpm + dir); els.bpm.value = p.bpm; checkpoint(); save(); } });
  }
  window.addEventListener('blur', endHold);
  document.addEventListener('visibilitychange', function () { if (document.hidden) endHold(); });

  // ---------- events ----------
  function on(id, ev, fn) { $(id).addEventListener(ev, fn); }
  function switchProject(id) { stopPlay(); lib.activeProjectId = id; cur = { cell: 0, str: 0 }; CL = cellsOf(); cur.cell = M.cellIndexAt(CL, phTick()); save(); render(); }
  function bind() {
    // transport
    on('play-btn', 'click', playPause);
    on('play-start', 'click', backToStart);
    on('stop-btn', 'click', function () { stopPlay({ user: true }); });
    els.clickToggle.addEventListener('click', function () { var p = project(); p.metronome = !p.metronome; changed(); toast(p.metronome ? 'Metronome on' : 'Metronome off'); });
    els.loopToggle.addEventListener('click', function () { var L = project().loop; L.enabled = !L.enabled; changed(); restartIfPlaying(); toast(L.enabled ? 'Loop on: bars ' + L.startMeasure + '–' + L.endMeasure : 'Loop off'); });
    var setBpm = function (v) { var p = project(); p.bpm = clampBpm(v); els.bpm.value = p.bpm; checkpoint(); save(); };
    bindBpmHold(els.bpmDown, -1); bindBpmHold(els.bpmUp, 1);
    els.bpm.addEventListener('change', function () { setBpm(Number(els.bpm.value)); });
    els.gridSelect.addEventListener('change', function () { setGrid(els.gridSelect.value); });
    els.gridDot.addEventListener('click', function () { toggleStyle('dotted'); });
    els.gridTrip.addEventListener('click', function () { toggleStyle('triplet'); });
    on('prev-col', 'click', function () { moveStep(-1); });
    on('next-col', 'click', nextStep);
    on('undo-btn', 'click', undo);
    on('redo-btn', 'click', redo);
    bindRuler();

    // track strip
    els.tracks.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var p = project();
      if (b.id === 'track-add') {
        if (p.tracks.length >= M.LIMITS.tracks) { toast('Up to ' + M.LIMITS.tracks + ' tracks per project'); return; }
        var t = M.newTrack('Guitar ' + (p.tracks.length + 1)); t.tuning = JSON.parse(JSON.stringify(track().tuning)); t.style = M.trackStyle(track());
        var aft = keepTick(function () { p.tracks.push(t); p.activeTrackId = t.id; }); changed(); aft(); toast('Added ' + t.name + ' (armed)');
        return;
      }
      var row = b.closest('.trk'); if (!row) return;
      var tr = p.tracks.filter(function (x) { return x.id === row.dataset.track; })[0]; if (!tr) return;
      if (b.dataset.act === 'arm') { var af = keepTick(function () { p.activeTrackId = tr.id; }); save(); render(); af(); }
      else if (b.dataset.act === 'mute') { tr.mute = !tr.mute; save(); render(); }
      else if (b.dataset.act === 'solo') { tr.solo = !tr.solo; save(); render(); }
      else if (b.dataset.act === 'tone') { if (tonePop && !tonePop.hidden && toneFor === tr.id) closeTones(); else openTones(b, tr); }
    });
    els.tracks.addEventListener('input', function (e) {
      var v = e.target.closest('.vol'); if (!v) return;
      var row = v.closest('.trk'), tr = project().tracks.filter(function (x) { return x.id === row.dataset.track; })[0];
      if (tr) { tr.volume = Math.max(0, Math.min(100, Math.round(Number(v.value)))); v.title = 'Volume ' + tr.volume; save(); }
    });

    // grid + picker
    els.editor.addEventListener('click', function (e) { var b = e.target.closest('.cell'); if (b) openPicker(Number(b.dataset.col), Number(b.dataset.str)); });
    els.neck.addEventListener('click', function (e) { var b = e.target.closest('.frow'); if (b) setEvent(Number(b.dataset.fret), false); });
    els.pickerStrings.addEventListener('click', function (e) { var b = e.target.closest('.chip'); if (b) { cur.str = Number(b.dataset.str); render(); } });
    els.pickMute.addEventListener('click', function () { setEvent(0, true); });
    on('pick-clear', 'click', function () { setEvent(undefined); });
    on('picker-next', 'click', nextStep);
    on('picker-prev', 'click', function () { moveStep(-1); });
    on('picker-next-bar', 'click', nextBar);
    on('picker-prev-bar', 'click', prevBar);
    on('picker-undo', 'click', function () { undo(); });
    on('picker-redo', 'click', function () { redo(); });
    els.pickerRoll.addEventListener('click', function (e) {
      var d = e.target.closest('.rc'); if (!d) return;
      cur.str = Number(d.dataset.str); moveStep(Number(d.dataset.col) - cur.cell);
    });
    on('picker-done', 'click', closePicker);
    bindChords();
    els.scrim.addEventListener('click', closePicker);

    // idea notes (pinned)
    els.idea.addEventListener('input', function () { project().idea = els.idea.value.slice(0, M.LIMITS.idea); save(); });

    // drawer
    on('menu-btn', 'click', function () { if (drawerOpen) closeDrawer(); else openDrawer(); });
    on('drawer-close', 'click', closeDrawer);
    els.drawerScrim.addEventListener('click', closeDrawer);
    els.projectSelect.addEventListener('change', function () { switchProject(els.projectSelect.value); });
    on('project-new', 'click', function () {
      var p = M.newProject(''); p.tracks[0].tuning = JSON.parse(JSON.stringify(track().tuning));
      lib.projects.push(p); switchProject(p.id); els.title.focus();
    });
    on('project-dup', 'click', function () {
      var c = M.normaliseProject(JSON.parse(JSON.stringify(project())));
      c.id = M.uid(); c.title = (c.title || 'Untitled') + ' (copy)'; c.createdAt = M.nowIso();
      lib.projects.push(c); switchProject(c.id); toast('Duplicated');
    });
    on('project-del', 'click', function () {
      var p = project();
      if (!confirm('Delete project "' + (p.title || 'Untitled') + '"? This cannot be undone.')) return;
      lib.projects = lib.projects.filter(function (x) { return x.id !== p.id; });
      if (!lib.projects.length) lib.projects.push(M.newProject(''));
      delete hist[p.id];
      switchProject(lib.projects[0].id);
    });
    els.title.addEventListener('input', function () { project().title = els.title.value.slice(0, M.LIMITS.title); save(); });
    els.title.addEventListener('change', function () { checkpoint(); renderDrawer(); });
    els.trackName.addEventListener('input', function () { track().name = els.trackName.value.slice(0, M.LIMITS.name); save(); renderTracks(); });
    els.trackName.addEventListener('change', function () { checkpoint(); });
    els.tuning.addEventListener('change', function () { if (els.tuning.value !== 'custom') { track().tuning = M.tuningFromId(els.tuning.value); changed(); } });
    on('track-del', 'click', function () {
      var p = project(), t = track();
      if (p.tracks.length <= 1) { toast('A project needs at least one track'); return; }
      if (!confirm('Delete track "' + (t.name || 'Untitled') + '"? (Undo can bring it back.)')) return;
      var af2 = keepTick(function () { p.tracks = p.tracks.filter(function (x) { return x.id !== t.id; }); p.activeTrackId = p.tracks[0].id; }); changed(); af2();
    });
    els.timesig.addEventListener('change', function () {
      stopPlay(); var tick = cell().start, p = project();
      p.timeSignature = els.timesig.value.split('/').map(Number); M.recompute(p); CL = cellsOf(); cur.cell = M.cellIndexAt(CL, tick); changed();
    });
    // Insert step: push every note of every track from this step onward one grid step later.
    on('add-col', 'click', function () {
      var p = project(), c = cell();
      if (M.measureCount(p) >= M.LIMITS.measures) return;
      p.tracks.forEach(function (t) { t.notes.forEach(function (n) { if (n.startTick >= c.start) n.startTick += c.len; }); });
      p.lengthTicks += c.len; changed({ scroll: true });
    });
    on('del-col', 'click', function () {
      var p = project(), c = cell(), end = c.start + c.len;
      p.tracks.forEach(function (t) {
        t.notes = t.notes.filter(function (n) { return n.startTick < c.start || n.startTick >= end; });
        t.notes.forEach(function (n) { if (n.startTick >= end) n.startTick -= c.len; });
      });
      changed();
    });
    on('add-measure', 'click', function () {
      var p = project(); if (M.measureCount(p) >= M.LIMITS.measures) return;
      var start = p.lengthTicks; p.lengthTicks += M.measureTicks(p); M.recompute(p); CL = cellsOf();
      cur.cell = M.cellIndexAt(CL, start); changed({ scroll: true });
    });
    on('del-measure', 'click', function () {
      var p = project(), mt = M.measureTicks(p), mc = M.measureCount(p);
      if (mc <= 1) { toast('A song needs at least one bar'); return; }
      var from = (mc - 1) * mt;
      stopPlay();
      p.tracks.forEach(function (t) { t.notes = t.notes.filter(function (n) { return n.startTick < from; }); });
      p.lengthTicks = from; changed(); toast('Last bar removed (Undo brings it back)');
    });
    on('clear-col', 'click', function () { var t = track(), c = cell(); t.notes = t.notes.filter(function (n) { return n.startTick < c.start || n.startTick >= c.start + c.len; }); changed(); });
    on('loop-start', 'click', function () { var L = project().loop, m = cell().measure; L.startMeasure = m; if (L.endMeasure < m) L.endMeasure = m; L.enabled = true; changed(); restartIfPlaying(); });
    on('loop-end', 'click', function () { var L = project().loop, m = cell().measure; L.endMeasure = m; if (L.startMeasure > m) L.startMeasure = m; L.enabled = true; changed(); restartIfPlaying(); });
    on('copy-ascii', 'click', function () {
      var text = toAscii(16);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('Tab copied as text'); }, function () { toast('Copy blocked by the browser'); });
      else toast('Copy not supported here');
    });
    on('export-one', 'click', function () { exportJson('project'); });
    on('export-all', 'click', function () { exportJson('library'); });
    on('export-midi', 'click', exportMidiSheet);
    els.shareBtn.addEventListener('click', share);
    on('import-btn', 'click', function () { els.importFile.value = ''; els.importFile.click(); });
    els.importFile.addEventListener('change', function () { importFile(els.importFile.files[0]); });

    // first-run hint
    on('hint-ok', 'click', function () { els.hint.hidden = true; try { localStorage.setItem(HINT_KEY, '1'); } catch (e) { /* ignore */ } });

    // Keyboard (when present): Space play/pause, Ctrl/Cmd+Z undo, Shift+Ctrl/Cmd+Z or Ctrl+Y redo, Home back to start,
    // L loop, [ / ] coarser / finer grid, . dotted, T triplet, arrows move; digits/x/Backspace edit while the picker is open; Esc closes.
    var buf = '', bufT = null;
    document.addEventListener('keydown', function (e) {
      var t = e.target, typing = t && (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type !== 'range'));
      if (CH.open && e.key === 'Escape' && els.modal.hidden) { if (CH.sel) { CH.sel = null; CH.mv = null; renderChords(); } else closeChords(); e.preventDefault(); return; }
      if (typing || !els.modal.hidden || e.altKey) return;
      var k = e.key;
      if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z')) { if (e.shiftKey) redo(); else undo(); e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'Y')) { redo(); e.preventDefault(); return; }
      if (e.ctrlKey || e.metaKey) return;
      if (CH.open) return;
      if (k === 'Escape') { if (pickerOpen) closePicker(); else if (drawerOpen) closeDrawer(); e.preventDefault(); }
      else if (k === ' ' && !pickerOpen) { playPause(); e.preventDefault(); }
      else if (k === 'Home' && !pickerOpen) { backToStart(); e.preventDefault(); }
      else if ((k === 'l' || k === 'L') && !pickerOpen) { els.loopToggle.click(); }
      else if ((k === 'm' || k === 'M') && !pickerOpen) { els.clickToggle.click(); }
      else if ((k === '[' || k === ']') && !pickerOpen) { stepGridValue(k === ']' ? 1 : -1); e.preventDefault(); }
      else if (k === '.' && !pickerOpen) { toggleStyle('dotted'); e.preventDefault(); }
      else if ((k === 't' || k === 'T') && !pickerOpen) { toggleStyle('triplet'); e.preventDefault(); }
      else if (drawerOpen) return;
      else if (k === 'ArrowLeft') { moveStep(-1); e.preventDefault(); }
      else if (k === 'ArrowRight') { moveStep(1); e.preventDefault(); }
      else if (k === 'ArrowUp') { cur.str = Math.max(0, cur.str - 1); render(); e.preventDefault(); }
      else if (k === 'ArrowDown') { cur.str = Math.min(M.STRINGS - 1, cur.str + 1); render(); e.preventDefault(); }
      else if (k === 'Enter' && !pickerOpen && document.activeElement === document.body) { openPicker(cur.cell, cur.str); e.preventDefault(); }
      else if (!pickerOpen) return;
      else if (/^[0-9]$/.test(k)) {
        buf += k; clearTimeout(bufT); var n = Number(buf); if (n > M.MAX_FRET) { buf = k; n = Number(k); }
        setEvent(n, false, true); bufT = setTimeout(function () { buf = ''; }, 700);
      } else if (k === 'x' || k === 'X') setEvent(0, true);
      else if (k === 'Backspace' || k === 'Delete') { setEvent(undefined); e.preventDefault(); }
    });
    // Another window of this site saved: pick up its library.
    window.addEventListener('storage', function (e) {
      if (e.key !== LIB_KEY || A.isPlaying()) return;
      var r = loadLibrary(); if (!r.restored) return;
      lib = r.lib; hist = {}; render();
    });
    window.addEventListener('resize', function () { syncRulerWidths(); fitPos(); if (pickerOpen) fitPicker(); if (CH.open && CH.sel) fitChords(); });
  }

  function init() {
    buildStatic();
    var r = loadLibrary();
    lib = r.lib;
    bind();
    CL = cellsOf();
    if (r.restored) cur.cell = M.cellIndexAt(CL, phTick());
    render();
    if (r.restored) {
      var d = new Date(project().updatedAt);
      els.saveState.textContent = 'Restored ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      els.saveState.className = 'save-state ok';
      if (r.migratedFrom) { save(); toast(r.migratedFrom >= 4 ? 'Library upgraded: note style is now per track (old copy kept as a backup)' : 'Library upgraded to multi-track (old copy kept as a backup)'); }
      showWarnings(r.warnings);
    } else save();
    var seen = false; try { seen = !!localStorage.getItem(HINT_KEY); } catch (e) { seen = false; }
    els.hint.hidden = seen;
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function () {});
    // v9: Sounds load after first paint and the load event (Nylon first, then whatever this project uses).
    A.onTone(function () { toneUi(); });
    // Wait for both the load event and the first contentful paint (headless/fast loads can paint after load).
    var painted = false, loaded = document.readyState === 'complete', go = function () { if (painted && loaded) setTimeout(startTones, 0); };
    var hasFcp = function () { return performance.getEntriesByName && performance.getEntriesByName('first-contentful-paint').length > 0; };
    if (hasFcp()) painted = true;
    else if (window.PerformanceObserver && (PerformanceObserver.supportedEntryTypes || []).indexOf('paint') >= 0) {
      var po = new PerformanceObserver(function () { if (hasFcp() && !painted) { painted = true; po.disconnect(); go(); } });
      po.observe({ type: 'paint', buffered: true });
      setTimeout(function () { if (!painted) { painted = true; go(); } }, 3000); // nothing painted (hidden tab): don't wait forever
    } else painted = true;
    if (!loaded) window.addEventListener('load', function () { loaded = true; go(); }, { once: true });
    go();
    window.addEventListener('resize', function () { closeTones(); });
  }

  // Read-only hook for automated checks.
  window.__guitarTab = { get library() { return JSON.parse(JSON.stringify(lib)); }, toAscii: function () { return toAscii(16); }, audioState: A.state, isPlaying: A.isPlaying,
    playhead: function () { return phCell(); }, playheadTick: function () { return phTick(); }, playingStep: function () { return playingStep; },
    editStep: function () { return cur.cell; }, cells: function () { return JSON.parse(JSON.stringify(CL)); }, grid: function () { return JSON.parse(JSON.stringify(grid())); },
    trackCells: function (i) { return JSON.parse(JSON.stringify(cellsOf(project().tracks[i]))); }, shareLog: function () { return shareLog.slice(); },
    audible: function () { return M.audibleTracks(project()).map(function (t) { return t.id; }); },
    history: function () { var h = H(); return { undo: h.undo.length, redo: h.redo.length }; },
    lastNote: function () { return A.lastNote(); }, chords: function () { var c = CH.open ? selChord() : null; return { open: CH.open, sel: CH.sel, mode: CH.mode, loaded: !!CH.list, mv: CH.mv && { shape: CH.mv.shape, r: CH.mv.r, n: CH.mv.n },
      cur: c && { name: c.name, code: C.code(c), frets: c.frets.slice(), fingers: c.fingers.slice(), barre: c.barre, notes: C.notes(c) } }; }, scheduled: function () { return A.scheduled(); },
    toneState: function (id) { return A.toneState(id); }, toneRequests: function () { return A.toneRequests(); }, waiting: function () { return !!playWait; },
    bpmHold: function () { return { holding: !!hold, log: holdLog.slice(), curve: HOLD }; },
    rhythm: function () { var p = project(); return groups(p, CL, buckets(track())).map(function (g) { return { len: g.len, beam: g.beam, beams: g.beamLevels, dot: g.dot, tp: g.tp, bracket: g.tpBracket, num: g.tpNum }; }); } };
  init();
})();
