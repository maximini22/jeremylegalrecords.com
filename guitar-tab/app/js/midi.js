/* Guitar Tab MIDI export: hand-written Standard MIDI File (Type 1) encoder, no build step, no libraries.
 * Works in the browser (window.TabMidi) and in Node (module.exports) so tests can call it directly.
 *
 * Layout (see docs/USER-GUIDE.md, "MIDI export"):
 *   MThd format 1, division 480 (same PPQ as the JSON, so ticks copy straight across).
 *   Track 0 (conductor): project title, tempo, time signature, loop start/end markers when the loop is on.
 *   Then one MTrk per exported guitar track: name, tuning (Instrument Name), a GM program from the track's Sound
 *   (v9, below), CC7 = volume, its own channel (track 1 -> ch 1, 2 -> ch 2, 3 -> ch 3), and the notes.
 * Programs (v9): GM numbers as printed in the GM 1 sound set (1-based): Nylon 25 and Spanish nylon 25 (Acoustic Guitar
 *   (nylon)), Clean electric 28 (Electric Guitar (clean)), Upright bass 33 (Acoustic Bass), Electric bass 34 (Electric
 *   Bass (finger)). The Program Change data byte is the number minus 1 (24, 24, 27, 32, 33). v8.2 and earlier wrote
 *   byte 25 for every track, which players read as GM 26, Acoustic Guitar (steel).
 * Notes: pitch = open string + fret; note on at startTick, off at startTick + durationTicks (the gated length).
 *   Bass Sounds (Upright bass, Electric bass) sound an octave below the tab, so their notes are written 12 lower.
 *   Muted (x): open-string pitch, velocity 30, 60 ticks (1/32). Hammer-on / pull-off: velocity 67 and the
 *   previous note on that string is held 10 ticks longer (legato overlap). Bends, slides, vibrato: not exported yet.
 *   Neck position: a Text meta event "s<string>f<fret>" (or "s<string>x") at each note's tick, before its note on.
 * Modes: 'all' = every track (up to 3), mixer state kept as CC7 and a " (muted)" / " (not soloed)" name suffix;
 *   a track id = conductor + that track only, whatever its mute/solo. */
(function (root) {
  'use strict';
  var PPQ = 480, VEL = 96, VEL_MUTED = 30, VEL_LEGATO = 67, MUTED_TICKS = 60, LEGATO_OVERLAP = 10;
  // Sound -> GM program (1-based, as in the GM spec; the byte written is program - 1) and octave (bass = -12).
  var PROGRAMS = { nylon: 25, spanish: 25, clean: 28, upright: 33, ebass: 34 }, BASS = { upright: true, ebass: true };
  var DEFAULT_TONE = 'nylon';
  function toneOf(t) { return t && PROGRAMS[t.tone] ? t.tone : DEFAULT_TONE; }
  function programOf(t) { return PROGRAMS[toneOf(t)]; }
  function octaveOf(t) { return BASS[toneOf(t)] ? -12 : 0; }

  function vlq(n) {
    var out = [n & 0x7f];
    while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
    return out;
  }
  function utf8(s) {
    s = String(s || '');
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(s));
    return Array.prototype.slice.call(Buffer.from(s, 'utf8'));
  }
  function meta(type, bytes) { return [0xff, type].concat(vlq(bytes.length), bytes); }
  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function u16(n) { return [(n >>> 8) & 255, n & 255]; }
  function measureTicks(p) { return Math.round(p.timeSignature[0] * PPQ * 4 / p.timeSignature[1]); }

  // events: [{ tick, order, data:[bytes] }] -> MTrk chunk bytes. order breaks ties at one tick:
  // 0 meta/setup, 1 note off, 2 text position, 3 note on.
  function chunk(events, endTick) {
    events.sort(function (a, b) { return a.tick - b.tick || a.order - b.order || (a.sub || 0) - (b.sub || 0); });
    var body = [], last = 0;
    events.forEach(function (e) { body.push.apply(body, vlq(e.tick - last)); body.push.apply(body, e.data); last = e.tick; });
    body.push.apply(body, vlq(Math.max(0, endTick - last))); body.push(0xff, 0x2f, 0x00);
    return [0x4d, 0x54, 0x72, 0x6b].concat(u32(body.length), body);
  }

  function audible(p) {
    var anySolo = p.tracks.some(function (t) { return t.solo; });
    return p.tracks.filter(function (t) { return !t.mute && (!anySolo || t.solo); });
  }
  function hasTech(n, a, b) { return (n.techniques || []).some(function (t) { return t === a || t === b; }); }

  // One guitar track -> list of events (and the last tick used).
  function trackEvents(p, t, ch, opts) {
    var ev = [], end = 0, name = t.name || 'Track';
    if (opts.suffix) name += opts.suffix;
    ev.push({ tick: 0, order: 0, sub: 0, data: meta(0x03, utf8(name)) });
    ev.push({ tick: 0, order: 0, sub: 1, data: meta(0x04, utf8((t.tuning.name || 'Custom') + ' [' + t.tuning.midi.join(' ') + ']')) });
    ev.push({ tick: 0, order: 0, sub: 2, data: [0xc0 | ch, programOf(t) - 1] });
    ev.push({ tick: 0, order: 0, sub: 3, data: [0xb0 | ch, 7, Math.round((t.volume == null ? 80 : t.volume) * 127 / 100)] });
    var oct = octaveOf(t);
    var notes = t.notes.slice().sort(function (a, b) { return a.startTick - b.startTick || b.string - a.string; });
    var spans = notes.map(function (n) {
      var muted = n.fret === null;
      var pitch = Math.max(0, t.tuning.midi[n.string - 1] + (muted ? 0 : n.fret) + oct);
      var len = muted ? Math.min(MUTED_TICKS, n.durationTicks || MUTED_TICKS) : Math.max(1, n.durationTicks || 1);
      var vel = muted ? VEL_MUTED : hasTech(n, 'hammer-on', 'pull-off') ? VEL_LEGATO : VEL;
      return { n: n, pitch: pitch, on: n.startTick, off: n.startTick + len, vel: vel, muted: muted };
    });
    // Legato: hold the previous note on the same string a few ticks into a hammer-on / pull-off.
    spans.forEach(function (s, i) {
      if (s.muted || !hasTech(s.n, 'hammer-on', 'pull-off')) return;
      for (var j = i - 1; j >= 0; j--) {
        var q = spans[j];
        if (q.n.string !== s.n.string || q.on >= s.on) continue;
        if (!q.muted && q.pitch !== s.pitch && q.off >= s.on) q.off = Math.max(q.off, s.on + LEGATO_OVERLAP);
        break;
      }
    });
    spans.forEach(function (s, i) {
      if (opts.posText) ev.push({ tick: s.on, order: 2, sub: i, data: meta(0x01, utf8('s' + s.n.string + (s.muted ? 'x' : 'f' + s.n.fret))) });
      ev.push({ tick: s.on, order: 3, sub: i, data: [0x90 | ch, s.pitch, s.vel] });
      ev.push({ tick: s.off, order: 1, sub: i, data: [0x80 | ch, s.pitch, 64] });
      end = Math.max(end, s.off);
    });
    return { ev: ev, end: end };
  }

  // build(project, { mode: 'all' | <track id>, posText: true }) -> Uint8Array
  function build(p, opts) {
    opts = opts || {};
    var mode = opts.mode || 'all', posText = opts.posText !== false;
    var aud = audible(p), anySolo = p.tracks.some(function (t) { return t.solo; });
    var picked = mode === 'all' ? p.tracks.slice(0, 16) : p.tracks.filter(function (t) { return t.id === mode; });
    if (!picked.length) throw new Error('No such track');
    var mt = measureTicks(p), songEnd = p.lengthTicks || mt;
    var tracks = picked.map(function (t) {
      var ti = p.tracks.indexOf(t), ch = ti >= 9 ? ti + 1 : ti; // skip channel 10 (drums)
      var suffix = mode === 'all' && aud.indexOf(t) < 0 ? (t.mute ? ' (muted)' : anySolo ? ' (not soloed)' : '') : '';
      return trackEvents(p, t, ch & 15, { posText: posText, suffix: suffix });
    });
    var end = songEnd; tracks.forEach(function (x) { end = Math.max(end, x.end); });
    // Conductor
    var ts = p.timeSignature, dd = Math.round(Math.log(ts[1]) / Math.LN2);
    var clocks = ts[1] === 8 && ts[0] % 3 === 0 ? 36 : Math.round(24 * 4 / ts[1]);
    var cond = [
      { tick: 0, order: 0, sub: 0, data: meta(0x03, utf8(p.title || 'Untitled')) },
      { tick: 0, order: 0, sub: 1, data: meta(0x51, u32(Math.round(60000000 / p.bpm)).slice(1)) },
      { tick: 0, order: 0, sub: 2, data: meta(0x58, [ts[0], dd, clocks, 8]) }
    ];
    if (mode !== 'all') cond.push({ tick: 0, order: 0, sub: 3, data: meta(0x01, utf8('Guitar Tab export: one track')) });
    if (p.loop && p.loop.enabled) {
      cond.push({ tick: (p.loop.startMeasure - 1) * mt, order: 0, sub: 4, data: meta(0x06, utf8('Loop start')) });
      cond.push({ tick: p.loop.endMeasure * mt, order: 0, sub: 5, data: meta(0x06, utf8('Loop end')) });
    }
    var bytes = [0x4d, 0x54, 0x68, 0x64].concat(u32(6), u16(1), u16(tracks.length + 1), u16(PPQ));
    bytes = bytes.concat(chunk(cond, end));
    tracks.forEach(function (x) { bytes = bytes.concat(chunk(x.ev, end)); });
    return new Uint8Array(bytes);
  }

  // File name = project title (track name added for single-track files). Characters no file system likes are dropped.
  function clean(s) { return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80); }
  function fileName(p, t) { var base = clean(p.title) || 'Untitled'; return (t ? base + ' - ' + (clean(t.name) || 'Track') : base) + '.mid'; }

  var api = { build: build, fileName: fileName, vlq: vlq, PPQ: PPQ, VEL: VEL, VEL_MUTED: VEL_MUTED, VEL_LEGATO: VEL_LEGATO, MUTED_TICKS: MUTED_TICKS, LEGATO_OVERLAP: LEGATO_OVERLAP,
    PROGRAMS: PROGRAMS, programOf: programOf, octaveOf: octaveOf, PROGRAM: PROGRAMS[DEFAULT_TONE] };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.TabMidi = api;
})(this);
