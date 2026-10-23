/* Guitar Tab app (v4): DAW-style UI for up to 3 tab tracks, library persistence, undo/redo, import/export.
 * Uses TabModel (js/model.js) and TabAudio (js/audio.js). Browser-only: nothing is uploaded, nothing to install. */
(function () {
  'use strict';
  var M = window.TabModel, A = window.TabAudio;
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
  ['save-state', 'menu-btn', 'play-start', 'play-btn', 'stop-btn', 'loop-toggle', 'bpm', 'grid-select', 'ph-info', 'undo-btn', 'redo-btn',
   'tracks', 'ruler-wrap', 'ruler', 'editor-wrap', 'editor', 'idea', 'drawer', 'drawer-scrim', 'project-select', 'title', 'track-name',
   'tuning', 'timesig', 'loop-info', 'ascii', 'import-file', 'share-btn', 'picker', 'scrim', 'picker-sub', 'neck', 'picker-strings',
   'picker-grid', 'pick-mute', 'picker-tip', 'toast', 'modal', 'modal-scrim', 'modal-h', 'modal-body', 'modal-actions', 'hint', 'song-info',
   'picker-roll', 'roll-bar', 'picker-undo', 'picker-redo'
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
      localStorage.setItem(STORE_KEY, JSON.stringify(lib));
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
      var raw = localStorage.getItem(STORE_KEY);
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
    var p = project(), o = JSON.parse(s), mix = {};
    p.tracks.forEach(function (t) { mix[t.id] = { volume: t.volume, mute: t.mute, solo: t.solo }; });
    Object.keys(o).forEach(function (k) { if (k !== 'id') p[k] = o[k]; });
    p.tracks.forEach(function (t) { var m = mix[t.id] || { volume: M.DEFAULT_VOLUME, mute: false, solo: false }; t.volume = m.volume; t.mute = m.mute; t.solo = m.solo; });
    if (!p.tracks.some(function (t) { return t.id === p.activeTrackId; })) p.activeTrackId = p.tracks[0].id;
    M.recompute(p); save(); render();
  }
  function undo() { checkpoint(); var h = H(); if (!h.undo.length) return; h.redo.push(h.base); h.base = h.undo.pop(); restore(h.base); toast('Undo'); }
  function redo() { checkpoint(); var h = H(); if (!h.redo.length) return; h.undo.push(h.base); h.base = h.redo.pop(); restore(h.base); toast('Redo'); }
  function undoUi() { var h = H(); els.undoBtn.disabled = !h.undo.length; els.redoBtn.disabled = !h.redo.length; }

  // ---------- grid ----------
  // One grid (snap) per project, plain values only. Every column is one grid step; notes keep their
  // absolute startTick, so changing the grid only changes how they are drawn.
  function grid() { var p = project(); if (!p.grid) p.grid = M.defaultGrid(); return p.grid; }
  function cellsOf() { return M.cells(project(), grid()); }
  var CL = []; // cells of the project at the current grid, refreshed on every render
  function cell(i) { return CL[i == null ? cur.cell : i]; }
  function notesIn(tr, c) { return tr.notes.filter(function (n) { return n.startTick >= c.start && n.startTick < c.start + c.len; }); }
  function notesOn(tr, c, no) { return notesIn(tr, c).filter(function (n) { return n.string === no; }); }
  function buckets(tr) { var b = CL.map(function () { return []; }); tr.notes.forEach(function (n) { b[M.cellIndexAt(CL, n.startTick)].push(n); }); return b; }
  function gridFrac(g) { return M.DUR_FRACTION[g.value]; }
  function lenLabel(ticks) {
    var d = M.nameTicks(ticks);
    return d ? { text: M.DUR_LETTER[d.value] + (d.dotted ? '.' : ''), d: d } : { text: '~', d: null };
  }

  // ---------- rhythm row (derived from note spacing of the armed track) ----------
  function groups(p, cl, bk) {
    var bt = M.beatTicks(p);
    var info = cl.map(function (c, i) {
      var first = bk[i][0] || null, L = first ? lenLabel(first.durationTicks) : null;
      return { measure: c.measure, barStart: i === 0 || c.measure !== cl[i - 1].measure, onset: !!first,
        len: L ? L.text : '', d: L ? L.d : null, beam: '', beamLevels: 0, stem: false };
    });
    var beamable = function (g) { return g.onset && g.d && !g.d.dotted && (g.d.value === 'eighth' || g.d.value === 'sixteenth'); };
    info.forEach(function (g) { g.stem = g.onset && !(g.d && g.d.value === 'whole'); });
    var i = 0;
    while (i < cl.length) {
      if (!beamable(info[i])) { i++; continue; }
      var beat = Math.floor(cl[i].start / bt), j = i, last = i;
      while (j + 1 < cl.length && Math.floor(cl[j + 1].start / bt) === beat && (beamable(info[j + 1]) || !info[j + 1].onset)) { j++; if (beamable(info[j])) last = j; }
      for (var k = i; k <= last; k++) {
        var g = info[k];
        g.beamLevels = g.d && g.d.value === 'sixteenth' ? 2 : 1;
        g.beam = i === last ? 'flag' : k === i ? 'start' : k === last ? 'end' : 'mid';
        if (!g.onset) { g.beamLevels = 1; g.stem = false; }
      }
      i = last + 1;
    }
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
  // bar|beat|sixteenth, as in a DAW position display (1|1|1 is the top of the song).
  function posLabel(tick) {
    var p = project(), mt = M.measureTicks(p), bt = M.beatTicks(p), inBar = tick % mt, beat = Math.floor(inBar / bt), sub = inBar - beat * bt;
    return (Math.floor(tick / mt) + 1) + '|' + (beat + 1) + '|' + (Math.floor(sub / 120) + 1);
  }
  function shownPh() { return A.isPlaying() && playingStep !== null && playProject === project().id ? playingStep : phCell(); }
  function markPlayhead(forced) {
    var ph = forced != null ? forced : shownPh();
    Array.prototype.forEach.call(els.editor.children, function (c, k) { if (k) c.classList.toggle('ph', k - 1 === ph); });
    Array.prototype.forEach.call(els.ruler.children, function (c, k) { if (k) { c.classList.toggle('ph', k - 1 === ph); c.setAttribute('aria-current', k - 1 === ph ? 'step' : 'false'); } });
    if (CL[ph]) { els.phInfo.textContent = posLabel(CL[ph].start); els.phInfo.title = 'Playhead at bar|beat|16th ' + posLabel(CL[ph].start); }
  }
  function countLabel(c) {
    var p = project(), mt = M.measureTicks(p), bt = M.beatTicks(p), inBar = c.start % mt, off = inBar % bt;
    if (!off) return { text: String(Math.floor(inBar / bt) + 1), beat: true };
    if (off * 2 === bt) return { text: '&', beat: false };
    if (off * 4 === bt) return { text: 'e', beat: false };
    if (off * 4 === bt * 3) return { text: 'a', beat: false };
    return { text: '·', beat: false };
  }

  // ---------- rendering ----------
  // Bar|beat ruler: top lane = bar numbers + loop brace (drag to set), bottom lane = beat counts (tap/drag = playhead).
  function renderRuler(info) {
    var L = project().loop, frag = document.createDocumentFragment();
    var sp = document.createElement('div'); sp.className = 'r-lab';
    sp.innerHTML = '<span>bar</span><span class="r-g"></span>';
    sp.lastChild.textContent = gridFrac(grid());
    sp.title = 'Grid ' + gridFrac(grid());
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
    for (var k = 0; k < rc.length && k < ec.length; k++) rc[k].style.width = ec[k].getBoundingClientRect().width + 'px';
    els.rulerWrap.scrollLeft = els.editorWrap.scrollLeft;
  }

  // Piano-roll style tab grid: 6 string lanes, time across. The armed track's notes are drawn in full;
  // the other tracks show as faint, colour-coded notes (or a coloured dot when the armed track also has one).
  function renderEditor() {
    var p = project(), tr = track(), ti = tindex(tr), labels = M.tuningLabels(tr.tuning), L = p.loop;
    CL = cellsOf(); clampCur();
    var BK = p.tracks.map(buckets), mine = BK[ti];
    var info = groups(p, CL, mine), ph = shownPh();
    els.editor.className = 'editor tc' + ti;
    var frag = document.createDocumentFragment();
    var lab = document.createElement('div'); lab.className = 'labels';
    labels.forEach(function (n) { var s = document.createElement('span'); s.textContent = n; lab.appendChild(s); });
    lab.insertAdjacentHTML('beforeend', '<div class="du">len</div><div class="bm"></div>');
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
      var bm = document.createElement('div'); bm.className = 'bm' + (g.beam ? ' b-' + g.beam + ' lv' + g.beamLevels : '') + (g.stem ? ' stem' : ' nostem');
      bm.innerHTML = '<i></i><i></i>'; col.appendChild(bm);
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
      arm.innerHTML = '<i class="sw" aria-hidden="true"></i><span class="nm"></span><small></small>';
      arm.children[1].textContent = name;
      arm.children[2].textContent = TUNING_SHORT[t.tuning.id] || 'Custom';
      var mb = document.createElement('button'); mb.type = 'button'; mb.className = 'ms m' + (t.mute ? ' on' : ''); mb.dataset.act = 'mute'; mb.textContent = 'M';
      mb.setAttribute('aria-pressed', t.mute ? 'true' : 'false'); mb.setAttribute('aria-label', 'Mute ' + name);
      var sb = document.createElement('button'); sb.type = 'button'; sb.className = 'ms s' + (t.solo ? ' on' : ''); sb.dataset.act = 'solo'; sb.textContent = 'S';
      sb.setAttribute('aria-pressed', t.solo ? 'true' : 'false'); sb.setAttribute('aria-label', 'Solo ' + name);
      var vol = document.createElement('input'); vol.type = 'range'; vol.min = 0; vol.max = 100; vol.step = 1; vol.value = t.volume; vol.className = 'vol'; vol.dataset.act = 'vol';
      vol.setAttribute('aria-label', 'Volume ' + name); vol.title = 'Volume ' + t.volume;
      row.appendChild(arm); row.appendChild(mb); row.appendChild(sb); row.appendChild(vol);
      frag.appendChild(row);
    });
    if (p.tracks.length < M.LIMITS.tracks) {
      var add = document.createElement('button'); add.type = 'button'; add.className = 'trk-add'; add.id = 'track-add';
      add.textContent = '+ Track (' + p.tracks.length + '/' + M.LIMITS.tracks + ')';
      frag.appendChild(add);
    }
    els.tracks.textContent = ''; els.tracks.appendChild(frag);
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
    els.gridSelect.value = grid().value;
    setToggle(els.loopToggle, L.enabled);
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
    lines.push(p.bpm + ' bpm · ' + p.timeSignature.join('/') + ' · grid ' + gridFrac(grid()) + (p.loop.enabled ? ' · loop bars ' + p.loop.startMeasure + '-' + p.loop.endMeasure : ''));
    if (p.idea) lines.push('Notes: ' + p.idea);
    var cl = cellsOf();
    p.tracks.forEach(function (tr) {
      var labels = M.tuningLabels(tr.tuning), w = Math.max.apply(null, labels.map(function (n) { return n.length; })), bk = buckets(tr), info = groups(p, cl, bk);
      lines.push('');
      lines.push('[' + (tr.name || 'Track') + '] ' + (tr.tuning.name || '') + (tr.mute ? ' · muted' : '') + (tr.solo ? ' · solo' : ''));
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
  function renderRoll() {
    var p = project(), tr = track(), ti = tindex(tr), labels = M.tuningLabels(tr.tuning), c = cell(), m = c.measure, ph = shownPh();
    var idx = []; CL.forEach(function (x, i) { if (x.measure === m) idx.push(i); });
    var bt = M.beatTicks(p), first = idx[0], last = idx[idx.length - 1];
    var BK = p.tracks.map(function (t) {
      var b = {}; t.notes.forEach(function (n) { var k = M.cellIndexAt(CL, n.startTick); if (k >= first && k <= last) (b[k] = b[k] || []).push(n); }); return b;
    });
    var roll = els.pickerRoll, frag = document.createDocumentFragment();
    roll.className = 'roll tc' + ti; roll.style.setProperty('--rc', idx.length);
    for (var si = 0; si < M.STRINGS; si++) {
      var lab = document.createElement('div'); lab.className = 'rl' + (si === cur.str ? ' sel' : ''); lab.textContent = labels[si]; frag.appendChild(lab);
      idx.forEach(function (ci) {
        var d = document.createElement('div'), mine = (BK[ti][ci] || []).filter(function (n) { return n.string === si + 1; })[0], gh = null, gk = 0;
        if (!mine) BK.forEach(function (b, k) { if (k !== ti && !gh) { var n = (b[ci] || []).filter(function (x) { return x.string === si + 1; })[0]; if (n) { gh = n; gk = k; } } });
        d.className = 'rc' + (ci === cur.cell ? ' now' : '') + (si === cur.str ? ' sel' : '') + ((CL[ci].start - (m - 1) * M.measureTicks(p)) % bt === 0 && ci !== first ? ' bt' : '') +
          (ci === ph ? ' ph' : '') + (mine ? ' has' : gh ? ' gh g' + gk : '');
        d.dataset.col = ci; d.dataset.str = si;
        if (mine) { var b = document.createElement('b'); b.textContent = cellText(mine); d.appendChild(b); } else if (gh) d.textContent = cellText(gh);
        frag.appendChild(d);
      });
    }
    roll.textContent = ''; roll.appendChild(frag);
    els.rollBar.textContent = 'Bar ' + m + ' of ' + M.measureCount(p) + ' · step ' + (idx.indexOf(cur.cell) + 1) + '/' + idx.length;
  }
  // Size the fret rows (and, if needed, the string chips) so the whole picker fits the visible screen without scrolling.
  function fitPicker() {
    var sh = els.picker, body = sh.querySelector('.picker-body'), side = sh.querySelector('.picker-side');
    var vh = Math.floor((window.visualViewport ? window.visualViewport.height : window.innerHeight) * 0.94);
    sh.style.setProperty('--frow', '20px'); sh.style.setProperty('--chip', '42px');
    var other = sh.scrollHeight - body.offsetHeight, avail = vh - other - 1;
    var over = side.scrollHeight - avail;
    if (over > 0) sh.style.setProperty('--chip', Math.max(30, 42 - Math.ceil(over / 6)) + 'px');
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
      var o = document.createElement('option'); o.value = v; o.textContent = M.DUR_FRACTION[v]; o.title = v; els.gridSelect.appendChild(o);
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
      A.preview(tr.tuning.midi[cur.str] + (muted ? 0 : fret), muted);
    }
    changed();
  }
  function setGrid(value) {
    var gd = grid(), tick = cell().start, wasPlaying = A.isPlaying() && playProject === project().id, playTick = wasPlaying && CL[playingStep] ? CL[playingStep].start : 0;
    gd.value = value;
    CL = cellsOf(); cur.cell = M.cellIndexAt(CL, tick);
    changed({ scroll: true });
    if (wasPlaying) startPlayback(M.cellIndexAt(CL, playTick));
    toast('Grid ' + gridFrac(gd));
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
  function startPlayback(from) {
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
            notes.push({ midi: t.tuning.midi[e.string - 1] + (e.fret || 0), muted: e.fret === null, offset: e.startTick - c.start, ticks: e.durationTicks, gain: t.volume / 100, track: ti });
          });
        });
        return { ticks: c.len, notes: notes };
      },
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
  function playPause() { if (A.isPlaying()) stopPlay(); else startPlayback(phCell()); }
  function startCell() { var lp = loopCells(project(), CL); return lp ? lp.a : 0; }
  // Back to start: jumps to the loop start (loop on) or bar 1; keeps playing if playing.
  function backToStart() { if (A.isPlaying()) startPlayback(startCell()); else { setPlayhead(startCell()); toast('Back to start'); } }
  // Stop (and Pause) keep the playhead where it stopped; Stop while already stopped returns to the start.
  function stopPlay(opts) {
    var was = A.isPlaying();
    A.stop();
    if (was) savePlayheads();
    else if (opts && opts.user) { setPlayhead(startCell()); toast('Back to start'); }
    playingStep = null; playProject = null; transportUi(); markPlaying(); markPlayhead();
  }
  function transportUi() {
    var on = A.isPlaying();
    els.playBtn.classList.toggle('on', on);
    els.playBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    els.playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
    els.playBtn.title = on ? 'Pause (Space)' : 'Play (Space)';
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

  // ---------- modal + toast ----------
  function toast(msg) {
    els.toast.textContent = msg; els.toast.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(function () { els.toast.hidden = true; }, 2600);
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
  function canShareFiles() {
    try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['{}'], 't.json', { type: 'application/json' })] })); } catch (e) { return false; }
  }
  function share() {
    var f = fileFor('project');
    navigator.share({ files: [new File([f.blob], f.name, { type: 'application/json' })], title: project().title || 'Guitar tab' })
      .catch(function (e) { if (e && e.name !== 'AbortError') toast('Share failed. Use Export instead.'); });
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

  // ---------- events ----------
  function on(id, ev, fn) { $(id).addEventListener(ev, fn); }
  function switchProject(id) { stopPlay(); lib.activeProjectId = id; cur = { cell: 0, str: 0 }; CL = cellsOf(); cur.cell = M.cellIndexAt(CL, phTick()); save(); render(); }
  function bind() {
    // transport
    on('play-btn', 'click', playPause);
    on('play-start', 'click', backToStart);
    on('stop-btn', 'click', function () { stopPlay({ user: true }); });
    els.loopToggle.addEventListener('click', function () { var L = project().loop; L.enabled = !L.enabled; changed(); restartIfPlaying(); toast(L.enabled ? 'Loop on: bars ' + L.startMeasure + '–' + L.endMeasure : 'Loop off'); });
    var setBpm = function (v) { var p = project(); p.bpm = Math.max(30, Math.min(300, Math.round(v) || 90)); els.bpm.value = p.bpm; checkpoint(); save(); };
    on('bpm-down', 'click', function () { setBpm(project().bpm - 1); });
    on('bpm-up', 'click', function () { setBpm(project().bpm + 1); });
    els.bpm.addEventListener('change', function () { setBpm(Number(els.bpm.value)); });
    els.gridSelect.addEventListener('change', function () { setGrid(els.gridSelect.value); });
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
        var t = M.newTrack('Guitar ' + (p.tracks.length + 1)); t.tuning = JSON.parse(JSON.stringify(track().tuning));
        p.tracks.push(t); p.activeTrackId = t.id; changed(); toast('Added ' + t.name + ' (armed)');
        return;
      }
      var row = b.closest('.trk'); if (!row) return;
      var tr = p.tracks.filter(function (x) { return x.id === row.dataset.track; })[0]; if (!tr) return;
      if (b.dataset.act === 'arm') { p.activeTrackId = tr.id; save(); render(); }
      else if (b.dataset.act === 'mute') { tr.mute = !tr.mute; save(); render(); }
      else if (b.dataset.act === 'solo') { tr.solo = !tr.solo; save(); render(); }
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
      p.tracks = p.tracks.filter(function (x) { return x.id !== t.id; }); p.activeTrackId = p.tracks[0].id; changed();
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
    // L loop, arrows move; digits/x/Backspace edit while the picker is open; Esc closes.
    var buf = '', bufT = null;
    document.addEventListener('keydown', function (e) {
      var t = e.target, typing = t && (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type !== 'range'));
      if (typing || !els.modal.hidden || e.altKey) return;
      var k = e.key;
      if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z')) { if (e.shiftKey) redo(); else undo(); e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'Y')) { redo(); e.preventDefault(); return; }
      if (e.ctrlKey || e.metaKey) return;
      if (k === 'Escape') { if (pickerOpen) closePicker(); else if (drawerOpen) closeDrawer(); e.preventDefault(); }
      else if (k === ' ' && !pickerOpen) { playPause(); e.preventDefault(); }
      else if (k === 'Home' && !pickerOpen) { backToStart(); e.preventDefault(); }
      else if ((k === 'l' || k === 'L') && !pickerOpen) { els.loopToggle.click(); }
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
      if (e.key !== STORE_KEY || A.isPlaying()) return;
      var r = loadLibrary(); if (!r.restored) return;
      lib = r.lib; hist = {}; render();
    });
    window.addEventListener('resize', function () { syncRulerWidths(); if (pickerOpen) fitPicker(); });
  }

  function init() {
    buildStatic();
    var r = loadLibrary();
    lib = r.lib;
    bind();
    if (canShareFiles()) els.shareBtn.hidden = false;
    CL = cellsOf();
    if (r.restored) cur.cell = M.cellIndexAt(CL, phTick());
    render();
    if (r.restored) {
      var d = new Date(project().updatedAt);
      els.saveState.textContent = 'Restored ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      els.saveState.className = 'save-state ok';
      if (r.migratedFrom) { save(); toast('Library upgraded to multi-track (old copy kept as a backup)'); }
      showWarnings(r.warnings);
    } else save();
    var seen = false; try { seen = !!localStorage.getItem(HINT_KEY); } catch (e) { seen = false; }
    els.hint.hidden = seen;
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function () {});
  }

  // Read-only hook for automated checks.
  window.__guitarTab = { get library() { return JSON.parse(JSON.stringify(lib)); }, toAscii: function () { return toAscii(16); }, audioState: A.state, isPlaying: A.isPlaying,
    playhead: function () { return phCell(); }, playheadTick: function () { return phTick(); }, playingStep: function () { return playingStep; },
    editStep: function () { return cur.cell; }, cells: function () { return JSON.parse(JSON.stringify(CL)); }, grid: function () { return JSON.parse(JSON.stringify(grid())); },
    audible: function () { return M.audibleTracks(project()).map(function (t) { return t.id; }); },
    history: function () { var h = H(); return { undo: h.undo.length, redo: h.redo.length }; },
    lastNote: function () { return A.lastNote(); }, scheduled: function () { return A.scheduled(); } };
  init();
})();
