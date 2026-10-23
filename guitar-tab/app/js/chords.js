/* Chord library helpers (pure, no DOM state): names relative to the tuning, movable shapes, notes to drop, and
 * chord-box SVGs. chords.json lists frets low E -> high e (index 0..5), the usual chord-chart order. The app numbers
 * strings 1 (high e) .. 6 (low E), so frets[i] is app string 6 - i. Boxes are drawn like a standard chord chart:
 * nut at the top, LOW E ON THE LEFT, high e on the right, string names under the box. Fret codes read the same way,
 * low to high (Em = 022000, A = x02220; power chords drop the unused high strings: F#5 = 244).
 *
 * Movable shapes (power chords, E- and A-shape barre chords) are worked out from the REAL string intervals of the
 * track's tuning: each shape is a list of target intervals above the root (per string, low to high), and each fret is
 * root fret + interval - (string pitch - root string pitch). In E standard a 6th-string power chord is r, r+2, r+2;
 * in drop D / drop C it becomes a one-finger barre r, r, r. Exposed as window.TabChords. */
(function (root) {
  'use strict';
  var STD = [64, 59, 55, 50, 45, 40]; // E standard, app string 1 (high e) .. 6 (low E)
  var NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  var SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var FLAT = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb' };
  var PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  var MAXF = 22;
  var QUALITY_PCS = { 'major': [0, 4, 7], 'minor': [0, 3, 7], 'dominant 7': [0, 4, 7, 10], 'power': [0, 7], 'diminished': [0, 3, 6],
    'augmented': [0, 4, 8], 'sus4': [0, 5, 7], 'sus2': [0, 2, 7] };
  var QUALITY_LONG = { 'major': 'major', 'minor': 'minor', 'dominant 7': 'dominant 7th', 'power': 'power chord (root + 5th)', 'diminished': 'diminished',
    'augmented': 'augmented', 'sus4': 'suspended 4th', 'sus2': 'suspended 2nd' };
  // Movable shapes: target intervals above the root, low E -> high e (null = not played). "pair" = the same chord with
  // its root on the other string (the 6th/5th toggle). Power chords: 3 notes (root, 5th, octave) or 2 (root, 5th).
  var SHAPES = {
    pow6: { family: 'power', quality: 'power', suffix: '5', string: 6, pair: 'pow5', iv: [0, 7, 12, null, null, null], label: '6th string' },
    pow5: { family: 'power', quality: 'power', suffix: '5', string: 5, pair: 'pow6', iv: [null, 0, 7, 12, null, null], label: '5th string' },
    maj6: { family: 'barre', quality: 'major', suffix: '', string: 6, pair: 'maj5', iv: [0, 7, 12, 16, 19, 24], label: 'E shape' },
    min6: { family: 'barre', quality: 'minor', suffix: 'm', string: 6, pair: 'min5', iv: [0, 7, 12, 15, 19, 24], label: 'E shape' },
    maj5: { family: 'barre', quality: 'major', suffix: '', string: 5, pair: 'maj6', iv: [null, 0, 7, 12, 16, 19], label: 'A shape' },
    min5: { family: 'barre', quality: 'minor', suffix: 'm', string: 5, pair: 'min6', iv: [null, 0, 7, 12, 15, 19], label: 'A shape' }
  };

  function strOf(i) { return 6 - i; }                // frets[] index -> app string number
  function low(midi, i) { return midi[5 - i]; }       // pitch of frets[] index i (low -> high) in this tuning
  function parseName(name) {
    var m = /^([A-G])([#b]?)(.*)$/.exec(name || '');
    if (!m) return null;
    return { pc: (PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12, suffix: m[3] };
  }
  function ivs(sh, n) {                               // intervals for the shape; n = 2 drops a power chord's octave
    var iv = sh.iv.slice();
    if (sh.family === 'power' && n === 2) { for (var i = 5; i >= 0; i--) if (iv[i] !== null) { iv[i] = null; break; } }
    return iv;
  }
  // Fret offsets of each string relative to the root fret, from the real string intervals.
  function offsets(sh, midi, n) {
    var iv = ivs(sh, n), ri = 6 - sh.string;
    return iv.map(function (v, i) { return v === null ? null : v - (low(midi, i) - low(midi, ri)); });
  }
  // Root-fret range: every fret 0..22 (top fret <= 22).
  function range(key, midi, n) {
    var off = offsets(SHAPES[key], midi, n), lo = 0, hi = MAXF;
    off.forEach(function (o) { if (o === null) return; lo = Math.max(lo, -o); hi = Math.min(hi, MAXF - o); });
    return { min: lo, max: hi };
  }
  function fingersFor(frets) {
    var fr = [], fing = frets.map(function (f) { return f === null ? null : 0; }), barre = null;
    frets.forEach(function (f, i) { if (f > 0) fr.push({ i: i, f: f }); });
    if (!fr.length) return { fingers: fing, barre: null };
    var minF = Math.min.apply(null, fr.map(function (x) { return x.f; })), atMin = fr.filter(function (x) { return x.f === minF; });
    var first = 0; while (first < 6 && frets[first] === null) first++;
    if (atMin.length >= 2 && frets[first] === minF) {     // a barre only when the lowest played string is under it
      var a = atMin[0].i, b = atMin[atMin.length - 1].i, ok = true;
      for (var k = a; k <= b; k++) if (!(frets[k] >= minF)) ok = false;
      if (ok) barre = { fret: minF, from: a + 1, to: b + 1, finger: 1 };
    }
    var prev = 0, rest = fr;
    if (barre) { atMin.forEach(function (x) { fing[x.i] = 1; }); prev = 1; rest = fr.filter(function (x) { return x.f !== minF; }); }
    rest.sort(function (x, y) { return x.f - y.f || x.i - y.i; }).forEach(function (x) { prev = Math.max(prev + 1, x.f - minF + 1); fing[x.i] = prev; });
    if (Math.max.apply(null, fing.map(function (v) { return v || 0; })) > 4) {   // too many fingers: one finger per fret (B = x13331, ring-finger barre)
      var ds = []; fr.forEach(function (x) { if (ds.indexOf(x.f) < 0) ds.push(x.f); }); ds.sort(function (x, y) { return x - y; });
      var dmin = ds[0], dn = ds.map(function (f, k) { return Math.min(4, Math.max(k + 1, f - dmin + 1)); });
      fr.forEach(function (x) { fing[x.i] = dn[ds.indexOf(x.f)]; });
    }
    return { fingers: fing, barre: barre };
  }
  function rootName(key, r, midi) {
    var sh = SHAPES[key], pc = (low(midi, 6 - sh.string) + r) % 12;
    return SHARP[pc] + sh.suffix;
  }
  // A movable shape at root fret r on this tuning, as a chord object (same fields as chords.json, plus .movable).
  function make(key, r, midi, n, id) {
    var sh = SHAPES[key], rg = range(key, midi, n);
    r = Math.max(rg.min, Math.min(rg.max, r));
    var off = offsets(sh, midi, n), frets = off.map(function (o) { return o === null ? null : r + o; });
    var fb = fingersFor(frets), played = frets.filter(function (f) { return f > 0; });
    var maxF = played.length ? Math.max.apply(null, played) : 0, minF = played.length ? Math.min.apply(null, played) : 0;
    var name = rootName(key, r, midi), pn = parseName(name), flat = FLAT[SHARP[pn.pc]];
    return { id: id || key + ':' + r, name: name, quality: sh.quality, family: sh.family, frets: frets, fingers: fb.fingers, barre: fb.barre,
      baseFret: maxF <= 4 ? 1 : minF, exact: true, aliases: flat ? [flat + sh.suffix] : [],
      movable: { shape: key, r: r, n: sh.family === 'power' ? (n === 2 ? 2 : 3) : null, string: sh.string, min: rg.min, max: rg.max, label: sh.label, pair: sh.pair } };
  }
  // Fret on the pair string that gives the same root (lowest one in range).
  function pairFret(key, r, midi, n) {
    var sh = SHAPES[key], to = sh.pair, p = (low(midi, 6 - sh.string) + r) % 12, rg = range(to, midi, n), base = low(midi, 6 - SHAPES[to].string);
    for (var f = rg.min; f <= rg.max; f++) if ((base + f) % 12 === p) return f;
    return rg.min;
  }
  // The library for this tuning: chords.json entries, with movable entries filled in. The power family is one card per
  // root (12), root on the 6th string up to fret 7, else on the 5th string (C5 = x355); each card also knows its
  // other-string position (for search). Barre entries name a shape and a root fret.
  function expand(data, midi) {
    var out = [];
    (data.chords || []).forEach(function (c) {
      if (c.movable && c.movable.roots === 'all') {
        var sw = c.movable.maxRootFret6 === undefined ? 7 : c.movable.maxRootFret6, base6 = low(midi, 0);
        for (var k = 0; k < 12; k++) {
          var r6 = k, key = c.movable.shape || 'pow6', pc = (base6 + k) % 12, pr = range('pow6', midi, 3);
          if (r6 < pr.min) r6 += 12;
          var ch = r6 <= sw || r6 > pr.max ? make('pow6', r6, midi, 3) : make('pow5', pairFret('pow6', r6, midi, 3), midi, 3);
          ch.id = 'P-' + SHARP[pc]; ch.alt = altCodes(ch, midi); out.push(ch);
        }
      } else if (c.movable && c.movable.shape) {
        // keep the entry's root note (F stays F in drop D: 333211), at the lowest fret that gives it on this tuning
        var sk = c.movable.shape, want = (low(STD, 6 - SHAPES[sk].string) + c.movable.fret) % 12, rr = range(sk, midi), fr0 = rr.min;
        while (fr0 < rr.max && (low(midi, 6 - SHAPES[sk].string) + fr0) % 12 !== want) fr0++;
        var m = make(sk, fr0, midi, null, c.id); m.alt = altCodes(m, midi); out.push(m);
      } else out.push(c);
    });
    return out;
  }
  function altCodes(c, midi) {
    var mv = c.movable, codes = [], o = make(mv.pair, pairFret(mv.shape, mv.r, midi, mv.n || 3), midi, mv.n || 3);
    codes.push(code(o), codeFull(o));
    if (mv.n) { var t2 = make(mv.shape, mv.r, midi, 2), o2 = make(o.movable.shape, o.movable.r, midi, 2); codes.push(code(t2), code(o2)); }
    return codes;
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
  // What the shape sounds as on this tuning. Movable shapes are built for the tuning, so their names are exact. Fixed
  // shapes: same shift on every string it uses: a transposed name ("Dm", shape "Em"); uneven shifts: the shape name.
  function label(c, tuningMidi) {
    if (c.exact) return { name: c.name, shape: c.name, exact: true, shift: 0, text: c.name };
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
  // Fret codes, low E first like a chord chart. code(): power chords leave off the unused high strings (244, x355);
  // codeFull(): always six strings. Two-digit frets are joined with dashes (8-10-10).
  function join(a) { return a.some(function (s) { return s.length > 1; }) ? a.join('-') : a.join(''); }
  function codeFull(c) { return join(c.frets.map(function (f) { return f === null ? 'x' : String(f); })); }
  function code(c) {
    var a = c.frets.map(function (f) { return f === null ? 'x' : String(f); });
    if (c.family === 'power') while (a.length > 2 && a[a.length - 1] === 'x') a.pop();
    return join(a);
  }
  function qualityLine(c) {
    if (c.movable) return c.family === 'power' ? 'root ' + c.movable.label : c.movable.label + ' · ' + c.quality;
    return c.barre ? c.quality + ' · barre ' + c.barre.fret : c.baseFret > 1 ? c.quality + ' · fret ' + c.baseFret : c.quality;
  }
  // Words match names, qualities and families anywhere; fret codes (digits, x, -) match the start of a code, so "244"
  // finds F#5 (244) but not B5 (x244).
  function search(list, q, tuningMidi) {
    q = String(q || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!q) return list.slice();
    return list.filter(function (c) {
      var lb = label(c, tuningMidi), codes = [code(c), codeFull(c)].concat(c.alt || []);
      var hay = [c.id, c.name, lb.name, c.quality, QUALITY_LONG[c.quality] || '', c.family, c.movable ? c.movable.label + ' movable' : ''].concat(c.aliases || []).join(' ').toLowerCase();
      return q.split(' ').every(function (w) {
        if (/^[0-9x-]+$/.test(w) && /\d/.test(w)) return codes.some(function (s) { return s.indexOf(w) === 0 || s.replace(/-/g, '').indexOf(w) === 0; });
        return hay.indexOf(w) >= 0;
      });
    });
  }

  var SEL = '#f5d547', TEAL = '#2ec4b6', AMBER = '#f5b942', LINE = 'rgba(154,166,184,.6)', NUT = '#d9d4c4';
  // Chord box SVG like a standard chart: nut at the top, LOW E ON THE LEFT (column 0), high e on the right, string
  // names (opts.labels, low -> high) under the box.
  function box(c, opts) {
    opts = opts || {};
    var maxF = Math.max.apply(null, c.frets.map(function (f) { return f || 0; })), rows = Math.max(4, maxF - c.baseFret + 1);
    var W = 80, H = 100, ml = 15, mr = 5, y0 = 17, fy = Math.min(17.25, 69 / rows), r = Math.min(6, fy * 0.36), sx = (W - ml - mr) / 5, fill = opts.sel ? SEL : TEAL;
    var X = function (i) { return ml + i * sx; }, Y = function (f) { return y0 + (f - c.baseFret + 0.5) * fy; }, yb = y0 + rows * fy;
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true" focusable="false">', k, i;
    for (k = 0; k <= rows; k++) s += '<line x1="' + ml + '" x2="' + (W - mr) + '" y1="' + (y0 + k * fy) + '" y2="' + (y0 + k * fy) + '" stroke="' + LINE + '" stroke-width="1"/>';
    for (i = 0; i < 6; i++) s += '<line x1="' + X(i) + '" x2="' + X(i) + '" y1="' + y0 + '" y2="' + yb + '" stroke="' + LINE + '" stroke-width="1"/>';
    if (c.baseFret === 1) s += '<rect x="' + (ml - 1) + '" y="' + (y0 - 3) + '" width="' + (W - ml - mr + 2) + '" height="3.5" rx="1" fill="' + NUT + '"/>';
    else s += '<text x="' + (ml - 7.5) + '" y="' + (y0 + 0.5 * fy + 3) + '" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="8" font-weight="700" fill="#9aa6b8">' + c.baseFret + '</text>';
    c.frets.forEach(function (f, i) {
      if (f === null) s += '<path d="M' + (X(i) - 3) + ' 4.5l6 6M' + (X(i) + 3) + ' 4.5l-6 6" stroke="' + AMBER + '" stroke-width="1.7" stroke-linecap="round"/>';
      else if (f === 0) s += '<circle cx="' + X(i) + '" cy="7.5" r="3.2" fill="none" stroke="#9aa6b8" stroke-width="1.4"/>';
    });
    var b = c.barre;
    if (b) { var xa = X(b.from - 1), xb = X(b.to - 1);
      s += '<rect x="' + (xa - r) + '" y="' + (Y(b.fret) - r) + '" width="' + (xb - xa + 2 * r) + '" height="' + (2 * r) + '" rx="' + r + '" fill="' + fill + '"/>'; }
    c.frets.forEach(function (f, i) {
      if (!f) return;
      var inBarre = b && f === b.fret && i >= b.from - 1 && i <= b.to - 1;
      if (inBarre && i !== b.from - 1) return;
      if (!inBarre) s += '<circle cx="' + X(i) + '" cy="' + Y(f) + '" r="' + r + '" fill="' + fill + '"/>'; // plain dots: no finger numbers (v8.2)
    });
    var lab = opts.labels || ['E', 'A', 'D', 'G', 'B', 'e'];
    lab.forEach(function (t, i) { s += '<text class="bs" x="' + X(i) + '" y="' + (H - 2) + '" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="7.5" font-weight="700" fill="#7d8899">' + String(t).replace(/[<&]/g, '') + '</text>'; });
    return s + '</svg>';
  }

  root.TabChords = { STD: STD, NAMES: NAMES, SHARP: SHARP, SHAPES: SHAPES, MAXF: MAXF, QUALITY_PCS: QUALITY_PCS, QUALITY_LONG: QUALITY_LONG, parseName: parseName,
    notes: notes, pitches: pitches, label: label, code: code, codeFull: codeFull, qualityLine: qualityLine, search: search, box: box,
    make: make, range: range, pairFret: pairFret, expand: expand, offsets: offsets };
})(typeof window !== 'undefined' ? window : globalThis);
