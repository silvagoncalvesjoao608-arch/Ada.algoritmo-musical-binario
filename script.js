/* PURE_START */
/* ========= Módulos sem DOM e sem áudio (testáveis fora do navegador) ========= */
const NOTE_NAMES = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si'];

/* Tudo o que a especificação ainda não definiu sobre a primeira mão fica aqui. */
const OPEN_RULES = {
  chordConsumesNext: false,  // o acorde pula os dois números seguintes? (indefinido)
  chordDuration: 'current'   // duração do acorde: a da nota atual (indefinido para as demais)
};

/* Input: valida o binário */
function validateBinary(raw) {
  const s = String(raw).replace(/\s+/g, '');
  if (!s) return { ok: false, error: 'Digite uma sequência de 0 e 1.' };
  if (!/^[01]+$/.test(s)) return { ok: false, error: 'Use somente os dígitos 0 e 1.' };
  return { ok: true, value: s };
}

/* Seed Processor: guarda a sequência original e o valor decimal (BigInt, sem perda de precisão) */
function processSeed(binarySeed) {
  return { binarySeed, numericSeed: BigInt('0b' + binarySeed) };
}

/* ALGORITMO 1: Fibonacci personalizado. N1 = N2 = semente, N(n) = N(n-1) + N(n-2).
   Gera sob demanda e só devolve números. Não sabe nada de notas, ritmo ou áudio. */
function createFibonacci(seed) {
  const cache = [seed, seed];
  return {
    get(i) {
      while (cache.length <= i) {
        const n = cache.length;
        cache.push(cache[n - 1] + cache[n - 2]);
      }
      return cache[i];
    },
    get generated() { return cache.length; }
  };
}

/* Binary Analyzer */
function toBinary(n) { return n.toString(2); }
function leadingOnes(bin) {
  let c = 0;
  while (c < bin.length && bin[c] === '1') c++;
  return c;
}
function durationFromBinary(bin) {
  const l = leadingOnes(bin);
  return l === 0 ? 0.5 : l;          // começa com 0 = 0,5 s; senão 1 s por 1 inicial
}
function isChordTrigger(bin) { return leadingOnes(bin) > 4; }

/* Note Mapper */
function noteIndex(n) { return Number(n % 12n); }

/* First Hand Generator: um evento por chamada, sob demanda */
function createFirstHand(fib, rules = OPEN_RULES) {
  let cursor = 0;
  let count = 0;
  return {
    next() {
      const number = fib.get(cursor);
      const binary = toBinary(number);
      const ones = leadingOnes(binary);
      const idx = noteIndex(number);
      const chord = ones > 4;
      const notes = [idx];
      if (chord) {
        notes.push(noteIndex(fib.get(cursor + 1)), noteIndex(fib.get(cursor + 2)));
      }
      const ev = {
        order: count++,
        position: cursor,
        number,
        binary,
        leadingOnes: ones,
        noteIndex: idx,
        noteName: NOTE_NAMES[idx],
        duration: ones === 0 ? 0.5 : ones,
        chord,
        notes,
        noteNames: notes.map(n => NOTE_NAMES[n])
      };
      cursor += (chord && rules.chordConsumesNext) ? 3 : 1;
      return ev;
    }
  };
}

/* Zero Analyzer: posições (base 1), quantidade e espaçamentos dos zeros da semente original */
function analyzeZeros(binarySeed) {
  const positions = [];
  for (let i = 0; i < binarySeed.length; i++) if (binarySeed[i] === '0') positions.push(i + 1);
  const gaps = [];
  for (let k = 1; k < positions.length; k++) gaps.push(positions[k] - positions[k - 1]);
  return { length: binarySeed.length, count: positions.length, positions, gaps };
}

/* Second Hand Generator.
   Cada regra recebe a análise dos zeros e devolve um padrão: { events, totalBeats }.
   events = [{ start, length, noteIndex }], em tempos. O padrão se repete enquanto a música toca.
   A regra real (zeros -> notas e ritmo) ainda não foi definida: basta registrar uma nova aqui. */
const SECOND_HAND_RULES = {
  none: {
    label: 'Indefinida (a segunda mão não toca)',
    build() { return { events: [], totalBeats: 4 }; }
  },
  provisional: {
    label: 'Provisória, só para testar a sincronização',
    build(z) {
      if (z.count === 0) return { events: [], totalBeats: 4 };
      const events = [];
      let t = 0;
      z.positions.forEach((p, k) => {
        const gap = z.gaps[k] ?? z.gaps[z.gaps.length - 1] ?? 4;
        const length = gap / 2;                 // zeros mais próximos: mais rápido
        events.push({ start: t, length, noteIndex: p % 12 });
        t += length;
      });
      return { events, totalBeats: t };
    }
  }
};

/* Altura: número MIDI (Dó4 = 60, Lá4 = 69 = 440 Hz), temperamento igual */
function midiOf(idx, octave) { return 12 * (octave + 1) + idx; }
function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function midiFreq(idx, octave) { return midiToFreq(midiOf(idx, octave)); }

/* Amostras de piano gravadas de Dó1 (24) a Dó8 (108), uma a cada 3 semitons.
   As notas entre duas amostras são obtidas mudando a velocidade em no máximo 1 semitom. */
const PIANO_ROOTS = [];
for (let m = 24; m <= 108; m += 3) PIANO_ROOTS.push(m);
function nearestRoot(midi) {
  let best = PIANO_ROOTS[0];
  for (const r of PIANO_ROOTS) if (Math.abs(r - midi) < Math.abs(best - midi)) best = r;
  return best;
}
/* PURE_END */

/* Amostras (base64, MP3 mono) indexadas pelo número MIDI da nota gravada. Preenchido na montagem. */

/* ========= Motor de áudio (Web Audio) ========= */
const LOOKAHEAD = 1.2;
const RELEASE = 0.35;   // tempo do abafador do piano ao soltar a nota
const WAVE_GAIN = { sine: 1, triangle: 1, square: 0.3, sawtooth: 0.35 };
function levelFor(instr) { return instr === 'piano' ? 0.9 : 0.6 * (WAVE_GAIN[instr] || 1); }

const engine = {
  ctx: null, master: null, bus1: null, bus2: null,
  timer: null, voices: new Set(), state: 'idle',
  gen: null, hooks: null, getCfg: null, it: null,
  log1: [], log2: [],
  buffers: {}, loadState: 'idle', loadPromise: null,

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.bus1 = this.ctx.createGain();
      this.bus2 = this.ctx.createGain();
      this.bus1.connect(this.master);
      this.bus2.connect(this.master);
      this.master.connect(this.ctx.destination);
    }
    if (this.state !== 'paused' && this.ctx.state === 'suspended') this.ctx.resume();
  },
  /* Decodifica as amostras uma única vez. Se falhar, o som sintético assume. */
  load() {
    if (this.loadPromise) return this.loadPromise;
    this.ensure();
    const entries = Object.entries(PIANO_SAMPLES);
    if (!entries.length) { this.loadState = 'failed'; this.loadPromise = Promise.resolve(false); return this.loadPromise; }
    this.loadState = 'loading';
    this.loadPromise = Promise.all(entries.map(async ([midi, b64]) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      this.buffers[midi] = await this.ctx.decodeAudioData(bytes.buffer);
    })).then(() => { this.loadState = 'ready'; return true; })
      .catch(err => { console.error('Falha ao carregar o piano:', err); this.loadState = 'failed'; return false; });
    return this.loadPromise;
  },
  setVolumes(c) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(c.vol, t, 0.03);
    this.bus2.gain.setTargetAtTime(c.vol2, t, 0.03);
  },
  sampleFor(midi) {
    const root = nearestRoot(midi);
    const buffer = this.buffers[root];
    return buffer ? { buffer, rate: Math.pow(2, (midi - root) / 12) } : null;
  },
  /* Uma nota: gravação de piano quando disponível, oscilador caso contrário */
  voice(midi, start, dur, instr, level, bus) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const sample = instr === 'piano' ? this.sampleFor(midi) : null;
    let src;
    let stopAt;
    if (sample) {
      src = ctx.createBufferSource();
      src.buffer = sample.buffer;
      src.playbackRate.value = sample.rate;
      const end = start + dur;
      g.gain.setValueAtTime(level, start);
      g.gain.setValueAtTime(level, end);
      g.gain.linearRampToValueAtTime(0.0001, end + RELEASE);
      stopAt = end + RELEASE + 0.05;
    } else {
      const wave = instr === 'piano' ? 'triangle' : instr;
      const lv = instr === 'piano' ? level * 0.35 : level;
      src = ctx.createOscillator();
      src.type = wave;
      src.frequency.value = midiToFreq(midi);
      const atk = Math.min(0.02, dur * 0.25);
      const rel = Math.min(0.15, dur * 0.3);
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(lv, start + atk);
      g.gain.setValueAtTime(lv, start + dur - rel);
      g.gain.linearRampToValueAtTime(0.0001, start + dur);
      stopAt = start + dur + 0.03;
    }
    src.connect(g);
    g.connect(bus);
    src.start(start);
    src.stop(stopAt);
    const v = { osc: src, g };
    this.voices.add(v);
    src.onended = () => { this.voices.delete(v); try { g.disconnect(); } catch (e) { /* já desconectado */ } };
  },
  stopVoices() {
    this.voices.forEach(v => {
      try { v.osc.stop(); } catch (e) { /* ainda não iniciada ou já parada */ }
      try { v.g.disconnect(); } catch (e) { /* já desconectado */ }
    });
    this.voices.clear();
  },

  play(gen, getCfg, hooks) {
    this.ensure();
    this.stopVoices();
    clearInterval(this.timer);
    this.ctx.resume();
    this.gen = gen; this.getCfg = getCfg; this.hooks = hooks;
    this.it = createFirstHand(gen.fib, gen.rules);
    const c = getCfg();
    this.setVolumes(c);
    const t0 = this.ctx.currentTime + 0.15;
    this.t1 = t0;
    this.count = 0;
    this.finished = false;
    this.endT = Infinity;
    this.k = 0;
    this.t2 = t0 + ((gen.second.events[0] ? gen.second.events[0].start : 0) * c.beat / c.tempo);
    this.log1 = [];
    this.log2 = [];
    this.state = 'playing';
    hooks.onStart(this.it);
    this.timer = setInterval(() => this.tick(), 80);
    this.tick();
  },

  tick() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const horizon = now + LOOKAHEAD;
    const c = this.getCfg();
    const f = 1 / c.tempo;

    /* primeira mão: gera só o que vai tocar nos próximos instantes */
    while (!this.finished && this.t1 < horizon) {
      const ev = this.it.next();
      const dur = ev.duration * f;
      const start = this.t1;
      const notes = [...new Set(ev.notes)];
      const level = levelFor(c.wave1) / Math.sqrt(notes.length);
      notes.forEach(n => this.voice(midiOf(n, c.oct1), start, dur, c.wave1, level, this.bus1));
      this.log1.push({ start, end: start + dur, ev });
      this.hooks.onEvent(ev);
      this.t1 = start + dur;
      this.count++;
      if (c.events > 0 && this.count >= c.events) { this.finished = true; this.endT = this.t1; }
    }

    /* segunda mão: padrão calculado uma vez, repetido até a primeira mão terminar */
    const pat = this.gen.second;
    const evs = pat.events;
    if (evs.length) {
      const beatS = c.beat * f;
      while (this.t2 < horizon && this.t2 < this.endT) {
        const e = evs[this.k];
        const start = this.t2;
        const dur = Math.min(e.length * beatS, this.endT - start);
        if (dur > 0.02) {
          this.voice(midiOf(e.noteIndex, c.oct2), start, dur, c.wave2, levelFor(c.wave2) * 0.8, this.bus2);
          this.log2.push({ start, end: start + dur, e, k: this.k });
        }
        const nextStart = (this.k + 1 < evs.length) ? evs[this.k + 1].start : pat.totalBeats + evs[0].start;
        this.t2 += Math.max(0.01, (nextStart - e.start) * beatS);
        this.k = (this.k + 1) % evs.length;
      }
    }

    if (this.finished && now >= this.endT) { this.finish(); return; }
    const cutoff = now - 4;
    this.log1 = this.log1.filter(x => x.end > cutoff);
    this.log2 = this.log2.filter(x => x.end > cutoff);
  },

  finish() {
    clearInterval(this.timer);
    this.state = 'idle';
    this.hooks.onEnd();
  },
  pause() {
    if (this.state !== 'playing') return;
    this.ctx.suspend();
    this.state = 'paused';
  },
  resume() {
    if (this.state !== 'paused') return;
    this.ctx.resume();
    this.state = 'playing';
  },
  stop() {
    const was = this.state;
    clearInterval(this.timer);
    this.state = 'idle';
    if (this.ctx) {
      this.stopVoices();
      this.ctx.resume();
    }
    this.log1 = [];
    this.log2 = [];
    if (was !== 'idle' && this.hooks) this.hooks.onStop();
  }
};

/* ========= Interface ========= */
const $ = id => document.getElementById(id);
const PREVIEW_ROWS = 12;
const state = { gen: null };
const fmtSec = s => s.toLocaleString('pt-BR') + ' s';
const short = (s, n) => (s.length > n ? s.slice(0, Math.ceil(n / 2) - 1) + '…' + s.slice(-(Math.floor(n / 2) - 1)) : s);

const ARROW = '<svg class="arrow" viewBox="0 0 12 22" aria-hidden="true"><path d="M6 0v18M1 13l5 6 5-6" stroke="currentColor" fill="none" stroke-width="1.5"/></svg>';
const BLACK_KEYS = [1, 3, 6, 8, 10];

function cfg() {
  return {
    events: Math.max(0, parseInt($('cfgEvents').value, 10) || 0),
    tempo: parseFloat($('cfgTempo').value) || 1,
    oct1: parseInt($('cfgOct1').value, 10),
    oct2: parseInt($('cfgOct2').value, 10),
    wave1: $('cfgWave1').value,
    wave2: $('cfgWave2').value,
    vol: parseInt($('cfgVol').value, 10) / 100,
    vol2: parseInt($('cfgVol2').value, 10) / 100,
    beat: Math.max(0.1, parseFloat($('cfgBeat').value) || 0.5),
    rule2: $('cfgRule2').value,
    chordConsumes: $('cfgChordConsume').checked
  };
}

/* Teclado de uma oitava, no mesmo desenho do piano de referência: 7 brancas, 5 pretas. */
function buildStatic() {
  const row = $('whiteRow');
  let whites = 0;
  NOTE_NAMES.forEach((name, i) => {
    const black = BLACK_KEYS.includes(i);
    const el = document.createElement('div');
    el.className = 'key ' + (black ? 'black' : 'white');
    el.id = 'k' + i;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', name + ', nota ' + i);
    el.innerHTML = `<span class="label">${name}</span><span class="keybind">${i}</span>`;
    if (black) el.style.left = (whites * (100 / 7) - 4) + '%';
    else whites++;
    row.appendChild(el);
    const trigger = e => { if (e) e.preventDefault(); playKey(i, el); };
    el.addEventListener('mousedown', trigger);
    el.addEventListener('touchstart', trigger, { passive: false });
  });
  $('cfgRule2').innerHTML = Object.entries(SECOND_HAND_RULES).map(([k, r]) => `<option value="${k}">${r.label}</option>`).join('');
  showOctaves();
}

function showOctaves() {
  const c = cfg();
  $('octaves').textContent = `Primeira mão na oitava ${c.oct1} · segunda mão na oitava ${c.oct2}`;
}

function binHtml(bin, ones) {
  const shown = bin.slice(0, 22);
  const l = Math.min(ones, shown.length);
  return `<span class="lead">${shown.slice(0, l)}</span>${shown.slice(l)}${bin.length > 22 ? '…' : ''}`;
}

function addRow(ev) {
  const tr = document.createElement('tr');
  tr.id = 'r' + ev.order;
  const numStr = ev.number.toString();
  const chord = ev.chord ? `${ev.noteNames.join(' + ')}<span class="chordtag">acorde</span>` : ev.noteName;
  tr.innerHTML = `<td>${ev.order + 1}</td>` +
    `<td><span class="num" title="${numStr}">${numStr}</span></td>` +
    `<td title="${ev.binary}">${binHtml(ev.binary, ev.leadingOnes)}</td>` +
    `<td>${ev.noteIndex}</td><td>${chord}</td><td>${fmtSec(ev.duration)}</td>`;
  $('rows').appendChild(tr);
}

function renderSeed(gen) {
  const dec = gen.seed.numericSeed.toString();
  $('seedBin').textContent = gen.seed.binarySeed;
  $('seedDec').textContent = dec.length > 60 ? dec.slice(0, 28) + '…' + dec.slice(-28) : dec;
  $('seedDec').title = dec;
  $('seedBits').textContent = gen.seed.binarySeed.length;
}

function renderFlow1(gen) {
  const items = [];
  for (let i = 0; i < 6; i++) {
    const num = gen.fib.get(i);
    const bin = toBinary(num);
    items.push({ num: num.toString(), bin, ones: leadingOnes(bin), idx: noteIndex(num), dur: durationFromBinary(bin) });
  }
  const dec = gen.seed.numericSeed.toString();
  const nums = items.map(x => `<span class="chip">${short(x.num, 12)}</span>`).join('') + '<span class="chip">…</span>';
  const notes = items.map(x => `<span class="chip h1">${short(x.num, 12)} % 12 = ${x.idx} → ${NOTE_NAMES[x.idx]}</span>`).join('');
  const rhythm = items.map(x => `<span class="chip h1">${binHtml(x.bin, x.ones)} → ${fmtSec(x.dur)}</span>`).join('');
  $('flow1').innerHTML =
    `<div class="stage"><span class="kicker">Binário</span><code>${short(gen.seed.binarySeed, 40)}</code></div>${ARROW}` +
    `<div class="stage"><span class="kicker">Semente</span><code>${short(dec, 40)}</code></div>${ARROW}` +
    `<div class="stage"><span class="kicker">Fibonacci personalizado (Algoritmo 1)</span><code>N₁ = N₂ = semente · N(n) = N(n−1) + N(n−2)</code></div>${ARROW}` +
    `<div class="stage"><span class="kicker">Números</span><div class="chips">${nums}</div></div>${ARROW}` +
    `<div class="fork">` +
      `<div class="stage"><span class="kicker">Mod 12 → Nota</span><div class="chips">${notes}</div></div>` +
      `<div class="stage"><span class="kicker">Binário → Ritmo</span><div class="chips">${rhythm}</div></div>` +
    `</div>${ARROW}` +
    `<div class="stage end-stage h1"><span class="kicker">Primeira mão (Algoritmo 2)</span><span>Nota e duração de cada número, na ordem da sequência.</span></div>`;
}

function listChips(list, cls) {
  const max = 40;
  const chips = list.slice(0, max).map(v => `<span class="chip ${cls}">${v}</span>`).join('');
  return chips + (list.length > max ? `<span class="chip">… +${list.length - max}</span>` : '');
}

function renderSecond(gen) {
  const z = gen.zeros;
  const bits = [...gen.seed.binarySeed].slice(0, 96)
    .map((b, i) => `<div class="bit${b === '0' ? ' z' : ''}"><b>${b}</b><small>${i + 1}</small></div>`).join('');
  const more = z.length > 96 ? `<div class="chip">… +${z.length - 96} bits</div>` : '';
  const pat = gen.second;
  $('flow2').innerHTML =
    `<div class="stage"><span class="kicker">Binário original</span><div class="bits">${bits}${more}</div></div>${ARROW}` +
    `<div class="stage"><span class="kicker">Zeros</span><span class="big">${z.count} ${z.count === 1 ? 'zero' : 'zeros'}</span></div>${ARROW}` +
    `<div class="stage"><span class="kicker">Posições</span><div class="chips">${z.count ? listChips(z.positions, 'h2') : '<span class="hint">Nenhum zero na semente.</span>'}</div></div>${ARROW}` +
    `<div class="stage"><span class="kicker">Espaçamentos</span><div class="chips">${z.gaps.length ? listChips(z.gaps, 'h2') : '<span class="hint">São necessários ao menos dois zeros.</span>'}</div></div>${ARROW}` +
    `<div class="stage end-stage h2"><span class="kicker">Segunda mão</span><span>${pat.events.length ? 'Padrão em 4 tempos, repetido durante a execução.' : 'Regra de notas e ritmo ainda não definida. A segunda mão não toca.'}</span></div>`;

  const barCount = Math.min(6, Math.max(1, Math.ceil(pat.totalBeats / 4)));
  let html = '';
  for (let b = 0; b < barCount; b++) {
    const evs = pat.events.map((e, k) => ({ e, k })).filter(({ e }) => Math.floor(e.start / 4) === b);
    const blocks = evs.map(({ e, k }) => {
      const off = e.start - b * 4;
      const w = Math.min(e.length, 4 - off);
      return `<div class="ev2" id="g${k}" style="left:${off / 4 * 100}%;width:${w / 4 * 100}%" title="Nota ${NOTE_NAMES[e.noteIndex]}, ${e.length} tempos">${NOTE_NAMES[e.noteIndex]}</div>`;
    }).join('');
    const empty = pat.events.length ? '' : '<div class="empty2">Regra indefinida</div>';
    html += `<div><div class="bar-label">Compasso ${b + 1}</div><div class="beats"><span>1</span><span>2</span><span>3</span><span>4</span>${blocks}${empty}</div></div>`;
  }
  if (pat.totalBeats / 4 > 6) html += '<p class="hint">O padrão continua além dos compassos mostrados.</p>';
  $('bars').innerHTML = html;
}

function setStatus(t) { $('status').textContent = t; }

function setButtons() {
  const s = engine.state;
  $('btnPause').disabled = s === 'idle';
  $('btnPause').textContent = s === 'paused' ? 'CONTINUAR' : 'PAUSAR';
  $('btnMore').disabled = s !== 'idle' || !state.gen;
}

let playToken = 0;
function halt() { playToken++; engine.stop(); }

function generate() {
  halt();
  const v = validateBinary($('binInput').value);
  if (!v.ok) { $('error').textContent = v.error; return false; }
  $('error').textContent = '';
  const c = cfg();
  const seed = processSeed(v.value);
  const fib = createFibonacci(seed.numericSeed);
  const rules = { ...OPEN_RULES, chordConsumesNext: c.chordConsumes };
  const zeros = analyzeZeros(seed.binarySeed);
  const second = SECOND_HAND_RULES[c.rule2].build(zeros);
  const gen = { seed, fib, rules, zeros, second, tableIt: createFirstHand(fib, rules) };
  state.gen = gen;
  renderSeed(gen);
  renderFlow1(gen);
  renderSecond(gen);
  $('rows').innerHTML = '';
  for (let i = 0; i < PREVIEW_ROWS; i++) addRow(gen.tableIt.next());
  $('tableWrap').scrollTop = 0;
  setStatus(`Pronto. Semente ${short(seed.numericSeed.toString(), 24)} com ${seed.binarySeed.length} bits.`);
  setButtons();
  return true;
}

const hooks = {
  onStart(it) {
    $('rows').innerHTML = '';
    state.gen.tableIt = it;
    setButtons();
  },
  onEvent(ev) { addRow(ev); },
  onEnd() { clearHighlight(); setStatus('Fim da execução.'); setButtons(); },
  onStop() { clearHighlight(); setStatus('Parado.'); setButtons(); }
};

/* Carrega o piano na primeira vez que for preciso. O áudio é criado já no clique, como os navegadores exigem. */
async function ensurePiano(c) {
  if (c.wave1 !== 'piano' && c.wave2 !== 'piano') return;
  engine.ensure();
  if (engine.loadState === 'idle') $('audioNote').textContent = 'Carregando o piano…';
  const ok = await engine.load();
  $('audioNote').textContent = ok ? '' : 'Não foi possível carregar as gravações de piano. Tocando com som sintético.';
}

async function startPlayback() {
  const typed = $('binInput').value.replace(/\s+/g, '');
  if (!state.gen || typed !== state.gen.seed.binarySeed) { if (!generate()) return; }
  if (!state.gen) return;
  halt();
  const token = playToken;
  engine.ensure();
  await ensurePiano(cfg());
  if (token !== playToken) return;
  engine.play(state.gen, cfg, hooks);
  setButtons();
}

/* Tocar uma tecla do teclado, como no piano de referência */
async function playKey(idx, el) {
  if (engine.state === 'paused') return;
  engine.ensure();
  const c = cfg();
  await ensurePiano(c);
  engine.setVolumes(c);
  engine.voice(midiOf(idx, c.oct1), engine.ctx.currentTime + 0.01, 1.2, c.wave1, levelFor(c.wave1), engine.bus1);
  el.classList.add('press');
  setTimeout(() => el.classList.remove('press'), 160);
}

/* ----- destaque sincronizado com o relógio do áudio ----- */
let lastOrder = -1;
let last2 = -1;
function clearHighlight() {
  document.querySelectorAll('.key.on1, .key.on2').forEach(el => el.classList.remove('on1', 'on2'));
  document.querySelectorAll('tr.now, .ev2.now').forEach(el => el.classList.remove('now'));
  lastOrder = -1; last2 = -1;
}
function frame() {
  if (engine.state !== 'idle' && engine.ctx) {
    const t = engine.ctx.currentTime;
    const a = engine.log1.find(x => t >= x.start && t < x.end);
    const b = engine.log2.find(x => t >= x.start && t < x.end);
    const o1 = a ? a.ev.order : -1;
    const o2 = b ? b.k : -1;
    if (o1 !== lastOrder || o2 !== last2) {
      document.querySelectorAll('.key.on1, .key.on2').forEach(el => el.classList.remove('on1', 'on2'));
      document.querySelectorAll('tr.now, .ev2.now').forEach(el => el.classList.remove('now'));
      if (a) {
        [...new Set(a.ev.notes)].forEach(n => $('k' + n).classList.add('on1'));
        const row = $('r' + a.ev.order);
        if (row) {
          row.classList.add('now');
          const wrap = $('tableWrap');
          wrap.scrollTop = Math.max(0, row.offsetTop - wrap.clientHeight / 2);
        }
        if (o1 !== lastOrder) setStatus(`Evento ${a.ev.order + 1}: ${a.ev.noteNames.join(' + ')} · ${fmtSec(a.ev.duration)}`);
      }
      if (b) {
        $('k' + b.e.noteIndex).classList.add('on2');
        const g = $('g' + b.k);
        if (g) g.classList.add('now');
      }
      lastOrder = o1; last2 = o2;
    }
  }
  requestAnimationFrame(frame);
}

/* ----- eventos ----- */
$('btnGen').addEventListener('click', generate);
$('btnPlay').addEventListener('click', () => {
  if (engine.state === 'paused') { engine.resume(); setButtons(); return; }
  startPlayback();
});
$('btnRestart').addEventListener('click', startPlayback);
$('btnPause').addEventListener('click', () => {
  if (engine.state === 'playing') engine.pause();
  else if (engine.state === 'paused') engine.resume();
  setButtons();
});
$('btnStop').addEventListener('click', () => { halt(); setButtons(); });
$('btnMore').addEventListener('click', () => {
  if (!state.gen || engine.state !== 'idle') return;
  for (let i = 0; i < PREVIEW_ROWS; i++) addRow(state.gen.tableIt.next());
});
$('binInput').addEventListener('input', e => { e.target.value = e.target.value.replace(/[^01]/g, ''); });
$('binInput').addEventListener('keydown', e => { if (e.key === 'Enter') generate(); });
$('cfgTempo').addEventListener('input', () => { $('outTempo').textContent = '×' + cfg().tempo.toLocaleString('pt-BR'); });
['cfgVol', 'cfgVol2'].forEach(id => $(id).addEventListener('input', () => engine.setVolumes(cfg())));
['cfgOct1', 'cfgOct2'].forEach(id => $(id).addEventListener('change', showOctaves));
['cfgRule2', 'cfgChordConsume'].forEach(id => $(id).addEventListener('change', () => { if (state.gen) generate(); }));

buildStatic();
setStatus('Digite uma sequência de 0 e 1 e toque em GERAR.');
requestAnimationFrame(frame);
