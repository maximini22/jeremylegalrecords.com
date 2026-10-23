/* Chord library helpers (pure, no DOM state): names relative to the tuning, notes to drop, and chord-box SVGs.
 * chords.json lists frets low E -> high e (index 0..5). The app numbers strings 1 (high e) .. 6 (low E), so
 * frets[i] is app string 6 - i. Boxes are drawn MIRRORED from the usual chord chart: high e on the left, low E on
 * the right, to match the app's neck (and its tab rows, high e at the top). Exposed as window.TabChords. */
(function (root) {
  'use strict';
  var STD = [64, 59, 55, 50, 45, 40]; // E standard, app string 1 (high e) .. 6 (low E)
  var NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  var PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  var QUALITY_PCS = { 'major': [0, 4, 7], 'minor': [0, 3, 7], 'dominant 7': [0, 4, 7, 10], 'power': [0, 7], 'diminished': [0, 3, 6],
    'augmented': [0, 4, 8], 'sus4': [0, 5, 7], 'sus2': [0, 2, 7] };
  var QUALITY_LONG = { 'major': 'major', 'minor': 'minor', 'dominant 7': 'dominant 7th', 'power': 'power chord (root + 5th)', 'diminished': 'diminished',
    'augmented': 'augmented', 'sus4': 'suspended 4th', 'sus2': 'suspended 2nd' };

  function strOf(i) { return 6 - i; }                // frets[] index -> app string number
  function parseName(name) {
    var m = /^([A-G])([#b]?)(.*)$/.exec(name || '');
    if (!m) return null;
    return { pc: (PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12, suffix: m[3] };
  }
  // Notes to write, low string first: [{ string, fret }]; muted (x) strings are left out.
  function notes(c) {
    var out = [];
    c.frets.forEach(function (f, i) { if (f !== null && f !== undefined) out.push({ string: strOf(i), fret: f }); });
    return out;
  }
  function pitches(c, tuningMidi) {
    return notes(c).map(function (n) { return tuningMidi[n.string - 1] + n.fret; });
  }
  // What the shape sounds as on this tuning. Same shift on every string it uses: a transposed name ("Dm", shape
  // "Em"). Uneven shifts (open / drop tunings that move only some of those strings): only the shape name.
  function label(c, tuningMidi) {
    var offs = [], ks = {};
    notes(c).forEach(function (n) { var k = tuningMidi[n.string - 1] - STD[n.string - 1]; offs.push(k); ks[k] = 1; });
    var keys = Object.keys(ks);
    if (keys.length === 1) {
      var k = Number(keys[0]);
      if (k === 0) return { name: c.name, shape: c.name, exact: true, shift: 0, text: c.name };
      var pn = parseName(c.name);
      if (pn) {
        var nm = NAMES[(pn.pc + k % 12 + 24) % 12] + pn.suffix;
        return { name: nm, shape: c.name, exact: false, shift: k, text: nm + ' (' + c.name + ' shape)', note: 'This tuning shifts every string the shape uses by ' + (k > 0 ? '+' : '') + k + ' semitone' + (Math.abs(k) === 1 ? '' : 's') + ', so the ' + c.name + ' shape sounds as ' + nm + '.' };
      }
    }
    return { name: c.name + ' shape', shape: c.name, exact: false, shift: null, text: c.name + ' shape',
      note: 'This tuning moves the strings unevenly, so the ' + c.name + ' shape will not sound as ' + c.name + ' here.' };
  }
  // fret code: box order (high e first) or chart order (low E first)
  function code(c, highFirst) {
    var a = c.frets.map(function (f) { return f === null ? 'x' : String(f); });
    if (highFirst) a.reverse();
    return a.some(function (s) { return s.length > 1; }) ? a.join('-') : a.join('');
  }
  function qualityLine(c) { return c.barre ? c.quality + ' · barre ' + c.barre.fret : c.baseFret > 1 ? c.quality + ' · fret ' + c.baseFret : c.quality; }
  function search(list, q, tuningMidi) {
    q = String(q || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!q) return list.slice();
    return list.filter(function (c) {
      var lb = label(c, tuningMidi);
      var hay = [c.id, c.name, lb.name, c.quality, QUALITY_LONG[c.quality] || '', c.family, code(c), code(c, true)].concat(c.aliases || []).join(' ').toLowerCase();
      return q.split(' ').every(function (w) { return hay.indexOf(w) >= 0; });
    });
  }

  var SEL = '#f5d547', TEAL = '#2ec4b6', AMBER = '#f5b942', LINE = 'rgba(154,166,184,.6)', NUT = '#d9d4c4';
  // Chord box SVG, nut at the top, HIGH e ON THE LEFT (column 0 = app string 1), low E on the right.
  function box(c, opts) {
    opts = opts || {};
    var W = 80, H = 90, ml = 15, mr = 5, y0 = 17, rows = 4, sx = (W - ml - mr) / 5, fy = (H - y0 - 4) / rows, r = 6, fill = opts.sel ? SEL : TEAL;
    var col = function (i) { return 5 - i; };       // frets[] index (low -> high) -> column (high e = 0)
    var X = function (i) { return ml + col(i) * sx; }, Y = function (f) { return y0 + (f - c.baseFret + 0.5) * fy; };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true" focusable="false">', k, i;
    for (k = 0; k <= rows; k++) s += '<line x1="' + ml + '" x2="' + (W - mr) + '" y1="' + (y0 + k * fy) + '" y2="' + (y0 + k * fy) + '" stroke="' + LINE + '" stroke-width="1"/>';
    for (i = 0; i < 6; i++) s += '<line x1="' + (ml + i * sx) + '" x2="' + (ml + i * sx) + '" y1="' + y0 + '" y2="' + (y0 + rows * fy) + '" stroke="' + LINE + '" stroke-width="1"/>';
    if (c.baseFret === 1) s += '<rect x="' + (ml - 1) + '" y="' + (y0 - 3) + '" width="' + (W - ml - mr + 2) + '" height="3.5" rx="1" fill="' + NUT + '"/>';
    else s += '<text x="' + (ml - r - 1.5) + '" y="' + (y0 + 0.5 * fy + 3) + '" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="8" font-weight="700" fill="#9aa6b8">' + c.baseFret + '</text>';
    c.frets.forEach(function (f, i) {
      if (f === null) s += '<path d="M' + (X(i) - 3) + ' 4.5l6 6M' + (X(i) + 3) + ' 4.5l-6 6" stroke="' + AMBER + '" stroke-width="1.7" stroke-linecap="round"/>';
      else if (f === 0) s += '<circle cx="' + X(i) + '" cy="7.5" r="3.2" fill="none" stroke="#9aa6b8" stroke-width="1.4"/>';
    });
    var b = c.barre;
    if (b) { var xa = Math.min(X(b.from - 1), X(b.to - 1)), xb = Math.max(X(b.from - 1), X(b.to - 1));
      s += '<rect x="' + (xa - r) + '" y="' + (Y(b.fret) - r) + '" width="' + (xb - xa + 2 * r) + '" height="' + (2 * r) + '" rx="' + r + '" fill="' + fill + '"/>'; }
    c.frets.forEach(function (f, i) {
      if (!f) return;
      var inBarre = b && f === b.fret && i >= b.from - 1 && i <= b.to - 1;
      if (inBarre && i !== b.from - 1) return;
      if (!inBarre) s += '<circle cx="' + X(i) + '" cy="' + Y(f) + '" r="' + r + '" fill="' + fill + '"/>';
      s += '<text x="' + X(i) + '" y="' + (Y(f) + 3) + '" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="8.5" font-weight="800" fill="#04201d">' + (c.fingers[i] || '') + '</text>';
    });
    return s + '</svg>';
  }

  root.TabChords = { STD: STD, NAMES: NAMES, QUALITY_PCS: QUALITY_PCS, QUALITY_LONG: QUALITY_LONG, parseName: parseName, notes: notes, pitches: pitches,
    label: label, code: code, qualityLine: qualityLine, search: search, box: box };
})(typeof window !== 'undefined' ? window : globalThis);
