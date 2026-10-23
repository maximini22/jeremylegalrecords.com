/* Web Audio plucked-string synth (Karplus-Strong) and a lookahead step scheduler for layered tracks (per-note gain). Exposed as window.TabAudio. */
(function () {
  'use strict';
  var ctx = null, master = null, unlocked = false;
  var cache = {};

  function ensure() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    master = ctx.createGain(); master.gain.value = 0.55;
    master.connect(comp); comp.connect(ctx.destination);
    return ctx;
  }
  // Mobile browsers only start audio inside a user gesture: create/resume and play one silent sample.
  function unlock() {
    if (unlocked && ctx && ctx.state === 'running') return;
    var c = ensure(); if (!c) return;
    if (c.state === 'suspended') c.resume();
    var b = c.createBuffer(1, 1, c.sampleRate), s = c.createBufferSource();
    s.buffer = b; s.connect(c.destination); s.start(0);
    unlocked = true;
  }
  ['pointerdown', 'touchend', 'keydown', 'click'].forEach(function (ev) {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  });

  function freq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  // Karplus-Strong: a noise burst through a damped delay line of one period.
  function pluckBuffer(midi, muted) {
    var key = midi + (muted ? 'm' : '');
    if (cache[key]) return cache[key];
    var sr = ctx.sampleRate, f = freq(midi);
    var len = Math.floor(sr * (muted ? 0.12 : 2.4));
    var buf = ctx.createBuffer(1, len, sr), out = buf.getChannelData(0);
    var N = Math.max(2, Math.round(sr / f)), line = new Float32Array(N);
    for (var i = 0; i < N; i++) line[i] = Math.random() * 2 - 1;
    var decay = muted ? 0.90 : 0.996 - Math.min(0.006, f / 200000), p = 0, prev = 0;
    for (var n = 0; n < len; n++) {
      var cur = line[p];
      var next = decay * 0.5 * (cur + prev);
      prev = cur; line[p] = next; out[n] = cur;
      p = (p + 1) % N;
    }
    // soften the attack click
    for (var a = 0; a < Math.min(64, len); a++) out[a] *= a / 64;
    cache[key] = buf;
    return buf;
  }

  // Play one note at time `when` for `dur` seconds (rings a little past, then fades).
  function note(midi, when, dur, opts) {
    var c = ensure(); if (!c) return;
    opts = opts || {};
    var muted = !!opts.muted;
    var src = c.createBufferSource(), g = c.createGain();
    src.buffer = pluckBuffer(midi, muted);
    var vol = (muted ? 0.35 : NOTE_PEAK) * (opts.gain == null ? 1 : opts.gain);
    if (vol <= 0) return;
    var end = when + Math.max(0.08, dur) + (muted ? 0 : 0.04);
    g.gain.setValueAtTime(vol, when);
    g.gain.setTargetAtTime(0, end, 0.04);
    src.connect(g); g.connect(master);
    src.start(when);
    src.stop(Math.min(when + src.buffer.duration, end + 0.4));
  }
  // Metronome click (v8.2): an MPC-style soft woody tick, synthesised (no samples): a band-passed noise burst plus a
  // short sine blip, ~15 ms decay. Fixed level: half the peak gain of a note on a fresh track (default volume), so
  // the per-track sliders don't change it. Beat 1 is the full level and a little higher; other beats are softer.
  var NOTE_PEAK = 0.5, CLICK_SOFT = 0.7, clickNoise = null, pend = [];
  function clickLevel() { var M = window.TabModel, dv = M && M.DEFAULT_VOLUME != null ? M.DEFAULT_VOLUME : 80; return 0.5 * NOTE_PEAK * dv / 100; }
  function click(when, accent) {
    var c = ensure(); if (!c) return;
    if (!clickNoise) {
      var len = Math.floor(c.sampleRate * 0.03); clickNoise = c.createBuffer(1, len, c.sampleRate);
      var d = clickNoise.getChannelData(0); for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (c.sampleRate * 0.004));
    }
    var lvl = clickLevel() * (accent ? 1 : CLICK_SOFT), out = c.createGain();
    out.gain.value = lvl; out.connect(master);
    pend = pend.filter(function (k) { return k.when > c.currentTime; }); pend.push({ out: out, when: when });
    var ns = c.createBufferSource(), bp = c.createBiquadFilter(), ng = c.createGain();
    ns.buffer = clickNoise; bp.type = 'bandpass'; bp.frequency.value = accent ? 2600 : 2000; bp.Q.value = 3.5;
    ng.gain.setValueAtTime(0.9, when); ng.gain.setTargetAtTime(0, when + 0.001, 0.005);
    ns.connect(bp); bp.connect(ng); ng.connect(out); ns.start(when); ns.stop(when + 0.04);
    var o = c.createOscillator(), og = c.createGain();
    o.type = 'sine'; o.frequency.value = accent ? 1250 : 950;
    og.gain.setValueAtTime(0, when); og.gain.linearRampToValueAtTime(0.8, when + 0.001); og.gain.setTargetAtTime(0, when + 0.002, 0.006);
    o.connect(og); og.connect(out); o.start(when); o.stop(when + 0.05);
    return lvl;
  }
  var last = null;
  function preview(midi, muted) { last = { midi: midi, muted: !!muted }; unlock(); if (!ctx) return; note(midi, ctx.currentTime + 0.01, 0.9, { muted: muted }); }

  // Scheduler: getSteps() returns [{seconds-free step}] lazily so BPM/edits apply on the next step.
  var timer = null, playing = null;
  function play(opts) {
    stop();
    unlock(); var c = ensure(); if (!c) return false;
    // opts: { count, startAt, stepAt(i) -> {ticks, notes:[{midi, muted, offset (ticks into the step), ticks (length), gain (0-1), track}]}, bpm(), ppq, loop, onStep(i|null) }
    playing = { opts: opts, i: Math.max(0, Math.min((opts.count || 1) - 1, opts.startAt || 0)), next: c.currentTime + 0.08, queue: [], raf: 0 };
    log = []; clog = [];
    // count-in (v8.2): opts.countIn = { beats, beatTicks } -> one bar of clicks before the first step (accent on 1)
    if (opts.countIn && opts.countIn.beats > 0) {
      var bs = opts.countIn.beatTicks / opts.ppq * 60 / opts.bpm(), ci0 = playing.next;
      for (var b = 0; b < opts.countIn.beats; b++) clog.push({ at: ci0 + b * bs, tick: null, accent: b === 0, countIn: true, gain: +click(ci0 + b * bs, b === 0).toFixed(4) });
      playing.next += opts.countIn.beats * bs;
    }
    t0 = playing.next;
    clog.forEach(function (k) { k.at = +(k.at - t0).toFixed(4); });
    timer = setInterval(tick, 25);
    tick();
    var draw = function () {
      if (!playing) return;
      var now = c.currentTime;
      while (playing.queue.length && playing.queue[0].t <= now) {
        var q = playing.queue.shift();
        if (q.end) { var cb = playing.opts.onStep; stop(); if (cb) cb(null); return; }
        playing.opts.onStep(q.i);
      }
      playing.raf = requestAnimationFrame(draw);
    };
    playing.raf = requestAnimationFrame(draw);
    return true;
  }
  function tick() {
    if (!playing) return;
    var P = playing, o = P.opts;
    while (P.next < ctx.currentTime + 0.15) {
      if (P.i >= o.count) {
        if (o.loop && o.count > 0) P.i = 0;
        else { if (!P.ended) { P.ended = true; P.queue.push({ t: P.next, end: true }); } return; }
      }
      var st = o.stepAt(P.i);
      var secs = st.ticks / o.ppq * 60 / o.bpm();
      var spt = 60 / o.bpm() / o.ppq; // seconds per tick
      // Layered tracks: each note carries its track's volume; thin out big stacks so 3 tracks don't clip.
      var stack = st.notes.length > 6 ? 0.6 : st.notes.length > 2 ? 0.8 : 1;
      st.notes.forEach(function (n) {
        var gain = (n.gain == null ? 1 : n.gain) * stack;
        if (log.length < 2000) log.push({ midi: n.midi, muted: !!n.muted, at: +(P.next + (n.offset || 0) * spt - t0).toFixed(4), step: P.i, track: n.track == null ? null : n.track, gain: +gain.toFixed(3) });
        note(n.midi, P.next + (n.offset || 0) * spt, (n.ticks || st.ticks) * spt, { muted: n.muted, gain: gain });
      });
      (st.clicks || []).forEach(function (k) {
        var at = P.next + k.offset * spt, g = click(at, k.accent);
        if (clog.length < 2000) clog.push({ at: +(at - t0).toFixed(4), tick: k.tick, accent: !!k.accent, gain: +(g || 0).toFixed(4), step: P.i });
      });
      P.queue.push({ t: P.next, i: P.i });
      P.next += secs; P.i++;
    }
  }
  var log = [], clog = [], t0 = 0; // what was scheduled, in seconds from the start of playback (for tests)
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (playing) { cancelAnimationFrame(playing.raf); playing = null; }
    // silence clicks scheduled ahead (the count-in queues a whole bar)
    if (ctx) pend.forEach(function (k) { if (k.when > ctx.currentTime) try { k.out.disconnect(); } catch (e) { /* gone */ } });
    pend = [];
  }
  window.TabAudio = { unlock: unlock, preview: preview, play: play, stop: stop, isPlaying: function () { return !!playing; },
    lastNote: function () { return last; }, scheduled: function () { return log.slice(); }, clicks: function () { return clog.slice(); },
    clickLevel: function () { return { level: clickLevel(), soft: CLICK_SOFT, notePeak: NOTE_PEAK, defaultTrackGain: 2 * clickLevel() }; }, state: function () { return ctx ? ctx.state : 'none'; } };
})();
