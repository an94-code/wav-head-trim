// Tests for wav-head-trim. Every fixture is synthesised in code — no binary
// sample files are shipped or read.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULTS,
    WavFormatError,
    adaptiveHeadWindowMs,
    attenuateHead,
    headMetrics,
    parseWav,
    processHead,
    trimLeadingAspiration,
} from '../lib/index.js';

const SR = 32000;

// --------------------------------------------------------------------------
// fixture builders
// --------------------------------------------------------------------------

/** Peak amplitude (0..1) of a full-scale sine whose RMS sits at `db`. */
const ampFromDb = (db) => Math.sqrt(2) * Math.pow(10, db / 20);

/** Canonical 44-byte-header PCM file. */
function wavFile({ sampleRate = SR, channels = 1, bitsPerSample = 16, formatTag = 1, data }) {
    const blockAlign = channels * bitsPerSample / 8;
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + data.length, 4);
    h.write('WAVE', 8);
    h.write('fmt ', 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(formatTag, 20);
    h.writeUInt16LE(channels, 22);
    h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(sampleRate * blockAlign, 28);
    h.writeUInt16LE(blockAlign, 32);
    h.writeUInt16LE(bitsPerSample, 34);
    h.write('data', 36);
    h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
}

/**
 * Synthesise a mono 16-bit file from a segment list.
 * Segment: { sec, db, freq } — `db: null` means exact digital silence.
 */
function synth(segments, { sampleRate = SR, channels = 1 } = {}) {
    const parts = [];
    for (const s of segments) {
        const n = Math.round(s.sec * sampleRate);
        const buf = Buffer.alloc(n * channels * 2);
        if (s.db !== null && s.db !== undefined) {
            const a = ampFromDb(s.db);
            const f = s.freq ?? 200;
            for (let i = 0; i < n; i++) {
                const v = Math.max(-32768, Math.min(32767,
                    Math.round(32767 * a * Math.sin(2 * Math.PI * f * i / sampleRate))));
                for (let c = 0; c < channels; c++)
                    buf.writeInt16LE(v, (i * channels + c) * 2);
            }
        }
        parts.push(buf);
    }
    return wavFile({ sampleRate, channels, data: Buffer.concat(parts) });
}

/** A file carrying an extra LIST chunk between `fmt ` and `data`. */
function wavWithList(data, { sampleRate = SR, channels = 1, bitsPerSample = 16 } = {}) {
    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0);
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(1, 8);
    fmt.writeUInt16LE(channels, 10);
    fmt.writeUInt32LE(sampleRate, 12);
    fmt.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 16);
    fmt.writeUInt16LE(channels * bitsPerSample / 8, 20);
    fmt.writeUInt16LE(bitsPerSample, 22);
    const list = Buffer.alloc(18, 0);
    list.write('LIST', 0);
    list.writeUInt32LE(10, 4);
    list.write('INFOhello!', 8);
    const d = Buffer.alloc(8);
    d.write('data', 0);
    d.writeUInt32LE(data.length, 4);
    const body = Buffer.concat([fmt, list, d, data]);
    const h = Buffer.alloc(12);
    h.write('RIFF', 0);
    h.writeUInt32LE(body.length, 4);
    h.write('WAVE', 8);
    return Buffer.concat([h, body]);
}

const seg = (sec, db, freq) => ({ sec, db, freq });

/** -75 dB = a real pause (near silence, but not digital silence). */
const PAUSE_DB = -75;

/** 3.0 s: 0.20 s of breath at -30 dB, 0.20 s pause, then loud speech. */
const FIAT_WIDE = () => synth([
    seg(0.20, -30), seg(0.20, PAUSE_DB), seg(1.10, -20), seg(1.50, -20),
]);

/** 3.1 s: slowly rising breath (0.50 s), 0.20 s pause, then speech at -22 dB. */
const FIAT_NARROW = () => synth([
    seg(0.05, -41), seg(0.05, -38), seg(0.05, -35), seg(0.05, -33), seg(0.05, -31),
    seg(0.05, -30), seg(0.05, -29.5), seg(0.05, -29), seg(0.05, -28.5), seg(0.05, -28.5),
    seg(0.20, PAUSE_DB), seg(1.20, -22), seg(1.20, -22),
]);

/** 3.0 s: 0.2 s of pure digital silence, then speech. */
const DIGITAL_SIL = () => synth([seg(0.20, null), seg(1.40, -20), seg(1.40, -20)]);

/** 3.0 s: breath, long pause ending at ~1.2 s, then speech — cut > 30 %. */
const OVER_CAP = () => synth([seg(0.50, -30), seg(0.70, PAUSE_DB), seg(0.90, -20), seg(0.90, -20)]);

/** 3.0 s of continuous speech — crisp onset, no valley. */
const CRISP = () => synth([seg(1.50, -20), seg(1.50, -20)]);

const head = (buf) => buf.subarray(0, 44 + 2 * 3200);

function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++)
        if (a[i] !== b[i])
            return i;
    return a.length === b.length ? -1 : n;
}

// --------------------------------------------------------------------------
// parseWav
// --------------------------------------------------------------------------

test('parseWav: reports the RIFF/WAVE layout of a 16-bit PCM mono file', () => {
    const wav = CRISP();
    const p = parseWav(wav);
    assert.equal(p.sampleRate, SR);
    assert.equal(p.channels, 1);
    assert.equal(p.bitsPerSample, 16);
    assert.equal(p.formatTag, 1);
    assert.equal(p.dataOffset, 44);
    assert.equal(p.dataLength, 3.0 * SR * 2);
    assert.equal(p.totalSamples, 3.0 * SR);
    assert.equal(p.totalFrames, 3.0 * SR);
    assert.equal(p.durationSec, 3.0);
    assert.equal(p.blockAlign, 2);
    assert.equal(p.byteRate, SR * 2);
    assert.deepEqual(p.chunks.map((c) => c.id), ['fmt ', 'data']);
});

test('parseWav: accepts a plain Uint8Array view of the same bytes', () => {
    const wav = CRISP();
    const view = new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength);
    assert.equal(parseWav(view).dataLength, wav.length - 44);
});

test('parseWav: finds data behind an extra LIST chunk', () => {
    const wav = wavWithList(CRISP().subarray(44));
    const p = parseWav(wav);
    assert.equal(p.dataOffset, 62);
    assert.deepEqual(p.chunks.map((c) => c.id), ['fmt ', 'LIST', 'data']);
});

// --------------------------------------------------------------------------
// headMetrics
// --------------------------------------------------------------------------

test('headMetrics: locates the valley and both peaks on a wide-gate fixture', () => {
    const m = headMetrics(FIAT_WIDE());
    assert.equal(m.ok, true);
    assert.equal(m.valleyFound, true);
    assert.ok(m.valleyStartSec > 0.15 && m.valleyStartSec < 0.35, 'valley start ' + m.valleyStartSec);
    assert.ok(m.riseTimeSec > 0.3, 'rise ' + m.riseTimeSec);
    assert.ok(m.headPeakDb < -25 && m.headPeakDb > -35, 'head peak ' + m.headPeakDb);
    assert.ok(m.tailPeakDb > -25, 'tail peak ' + m.tailPeakDb);
    assert.ok(m.deltaDb >= DEFAULTS.ratioDeltaDb, 'delta ' + m.deltaDb);
    assert.equal(m.headDigitalSilence, false);
    assert.equal(m.widePass, true);
    assert.equal(m.trimmed, true);
    assert.equal(m.windows.length, m.winCount);
});

test('headMetrics: flags a head made of pure digital silence', () => {
    const m = headMetrics(DIGITAL_SIL());
    assert.equal(m.headDigitalSilence, true);
    assert.equal(m.trimmed, false);
    assert.equal(m.code, 'digital-silence');
});

test('headMetrics: throws on unsupported / malformed input', () => {
    assert.throws(() => headMetrics(Buffer.alloc(10)), WavFormatError);
    assert.throws(() => headMetrics(Buffer.alloc(200)), WavFormatError);
    const eightBit = wavFile({ bitsPerSample: 8, data: Buffer.alloc(6000, 128) });
    assert.throws(() => headMetrics(eightBit), /16-bit/);
});

// --------------------------------------------------------------------------
// trimLeadingAspiration
// --------------------------------------------------------------------------

test('trimLeadingAspiration: leaves a crisp onset alone, byte for byte', () => {
    const wav = CRISP();
    const before = Buffer.from(wav);
    const { buffer, diag } = trimLeadingAspiration(wav);
    assert.equal(diag.trimmed, false);
    assert.equal(diag.code, 'no-valley');
    assert.equal(diag.changed, false);
    assert.deepEqual(buffer, wav);
    assert.deepEqual(wav, before, 'input must not be modified');
});

test('trimLeadingAspiration: cuts a wide-gate leading aspiration', () => {
    const wav = FIAT_WIDE();
    const total = (wav.length - 44) / 2;
    const before = Buffer.from(wav);
    const { buffer, diag } = trimLeadingAspiration(wav);
    assert.equal(diag.trimmed, true);
    assert.equal(diag.narrow, false);
    assert.ok(diag.cut >= 0.25 && diag.cut <= 0.6, 'cut ' + diag.cut);
    assert.equal(diag.oldSeconds, 3);
    assert.ok(diag.newSeconds < 3);
    // `cut` is a 2-decimal convenience value; `cutSample` is the exact one.
    assert.ok(Math.abs(diag.cutSample / SR - diag.cut) <= 0.005);
    assert.equal(diag.newTotalSamples, total - diag.cutSample);
    assert.equal((buffer.length - 44) / 2, diag.newTotalSamples);
    // canonical 44-byte header, data = the original tail
    assert.equal(parseWav(buffer).dataOffset, 44);
    assert.deepEqual(buffer.subarray(44), wav.subarray(44 + diag.cutSample * 2));
    assert.deepEqual(wav, before, 'input must not be modified');
});

test('trimLeadingAspiration: the narrow gate fires on a slow rising breath', () => {
    const wav = FIAT_NARROW();
    const { diag } = trimLeadingAspiration(wav);
    assert.ok(diag.deltaDb < DEFAULTS.ratioDeltaDb && diag.deltaDb >= DEFAULTS.narrowDeltaDb,
        'delta ' + diag.deltaDb + ' should sit in the narrow band');
    assert.ok(diag.headRiseSec >= DEFAULTS.riseMin, 'head rise ' + diag.headRiseSec);
    assert.equal(diag.trimmed, true);
    assert.equal(diag.narrow, true);
});

test('trimLeadingAspiration: delta below the wide gate and a short head rise => untouched', () => {
    // same slow-rise fixture, but riseMin raised past the peak-basis head rise
    const wav = FIAT_NARROW();
    const { diag, buffer } = trimLeadingAspiration(wav, { riseMin: 0.5 });
    assert.equal(diag.trimmed, false);
    assert.equal(diag.code, 'weak-onset');
    assert.ok(diag.deltaDb < DEFAULTS.ratioDeltaDb);
    assert.deepEqual(buffer, wav);
});

test('trimLeadingAspiration: digital-silence guard wins over a detected valley', () => {
    const wav = DIGITAL_SIL();
    const before = Buffer.from(wav);
    const { buffer, diag } = trimLeadingAspiration(wav);
    assert.equal(diag.trimmed, false);
    assert.equal(diag.code, 'digital-silence');
    assert.equal(diag.headDigitalSilence, true);
    assert.deepEqual(buffer, wav);
    assert.deepEqual(wav, before);
});

test('trimLeadingAspiration: refuses a cut above the 30 % cap', () => {
    const wav = OVER_CAP();
    const { buffer, diag } = trimLeadingAspiration(wav);
    assert.equal(diag.trimmed, false);
    assert.equal(diag.code, 'over-cap');
    assert.ok(diag.cutRatio > DEFAULTS.maxTrimRatio, 'cut ratio ' + diag.cutRatio);
    assert.match(diag.reason, /30% cap/);
    assert.deepEqual(buffer, wav);
});

test('trimLeadingAspiration: the cap is a real option', () => {
    const wav = OVER_CAP();
    const { diag } = trimLeadingAspiration(wav, { maxTrimRatio: 0.5 });
    assert.equal(diag.trimmed, true);
    assert.ok(diag.cutRatio > 0.3 && diag.cutRatio < 0.5);
});

test('trimLeadingAspiration: riseMin is a real option', () => {
    const wav = FIAT_WIDE();
    assert.equal(trimLeadingAspiration(wav, { riseMin: 1.5 }).diag.trimmed, false);
    assert.equal(trimLeadingAspiration(wav, { riseMin: 1.5 }).diag.code, 'crisp-onset');
});

test('trimLeadingAspiration: rewrites a padded header into a canonical 44-byte one', () => {
    const wav = wavWithList(FIAT_WIDE().subarray(44));
    const { buffer, diag } = trimLeadingAspiration(wav);
    assert.equal(diag.trimmed, true);
    assert.equal(parseWav(buffer).dataOffset, 44);
    assert.equal(buffer.length, 44 + diag.newTotalSamples * 2);
});

test('trimLeadingAspiration: unsupported input is reported, not thrown (strict=true throws)', () => {
    const eightBit = wavFile({ bitsPerSample: 8, data: Buffer.alloc(6000, 128) });
    const before = Buffer.from(eightBit);
    const r = trimLeadingAspiration(eightBit);
    assert.equal(r.diag.trimmed, false);
    assert.equal(r.diag.code, 'unsupported-format');
    assert.deepEqual(r.buffer, eightBit);
    assert.deepEqual(eightBit, before);
    assert.throws(() => trimLeadingAspiration(eightBit, { strict: true }), WavFormatError);
    assert.throws(() => trimLeadingAspiration(Buffer.alloc(20), { strict: true }), WavFormatError);
    assert.throws(() => trimLeadingAspiration('not a buffer'), TypeError);
});

// --------------------------------------------------------------------------
// attenuateHead
// --------------------------------------------------------------------------

test('attenuateHead: touches only the head window, byte for byte', () => {
    const wav = CRISP();
    const before = Buffer.from(wav);
    const { buffer, diag } = attenuateHead(wav, { ms: 100, gainDb: -15, fadeMs: 40 });
    assert.equal(diag.ok, true);
    assert.equal(diag.samplesPerChannel, 3200);
    assert.equal(diag.fadeSamples, 1280);
    assert.equal(diag.sampleRate, SR);
    assert.equal(buffer.length, wav.length);
    // header untouched
    assert.deepEqual(buffer.subarray(0, 44), wav.subarray(0, 44));
    // inside the window: attenuated, first sample well inside the fade-free zone
    const input0 = wav.readInt16LE(44 + 10 * 2);
    const out0 = buffer.readInt16LE(44 + 10 * 2);
    assert.ok(Math.abs(out0) < Math.abs(input0), 'sample 10 should be attenuated');
    const ratio = out0 / input0;
    assert.ok(Math.abs(20 * Math.log10(Math.abs(ratio)) + 15) < 1.5, 'gain ' + (20 * Math.log10(Math.abs(ratio))));
    // everything at/after the window is identical
    const windowEnd = 44 + 2 * 3200;
    assert.equal(firstDiff(buffer.subarray(windowEnd), wav.subarray(windowEnd)), -1);
    assert.deepEqual(wav, before, 'input must not be modified');
});

test('attenuateHead: the window length is clamped to the file length', () => {
    const wav = synth([seg(0.05, -20)]);
    const { diag } = attenuateHead(wav, { ms: 300, gainDb: -15, fadeMs: 40 });
    assert.equal(diag.samplesPerChannel, Math.floor(0.05 * SR));
});

test('attenuateHead: gainDb 0 and ms 0 are no-ops', () => {
    const wav = CRISP();
    assert.deepEqual(attenuateHead(wav, { gainDb: 0 }).buffer, wav);
    assert.deepEqual(attenuateHead(wav, { ms: 0 }).buffer, wav);
    assert.equal(attenuateHead(wav, { ms: 0 }).diag.changed, false);
    assert.equal(attenuateHead(wav, { gainDb: 0 }).diag.changed, false);
});

test('attenuateHead: non-16-bit input is reported, and strict=true throws', () => {
    const eightBit = wavFile({ bitsPerSample: 8, data: Buffer.alloc(6000, 128) });
    const r = attenuateHead(eightBit);
    assert.equal(r.diag.ok, false);
    assert.deepEqual(r.buffer, eightBit);
    assert.throws(() => attenuateHead(eightBit, { strict: true }), WavFormatError);
});

// --------------------------------------------------------------------------
// adaptiveHeadWindowMs
// --------------------------------------------------------------------------

test('adaptiveHeadWindowMs: voice at the very head => minMs', () => {
    const wav = synth([seg(1.0, -20), seg(1.0, -20)]);
    assert.equal(adaptiveHeadWindowMs(wav), DEFAULTS.minMs);
});

test('adaptiveHeadWindowMs: voice at ~100 ms => ~100 ms', () => {
    const wav = synth([seg(0.10, -45), seg(1.90, -20)]);
    assert.equal(adaptiveHeadWindowMs(wav), 100);
});

test('adaptiveHeadWindowMs: never gets up inside scanMs => full maxMs', () => {
    const wav = synth([seg(0.50, -45), seg(1.50, -20)]);
    assert.equal(adaptiveHeadWindowMs(wav), DEFAULTS.maxMs);
});

test('adaptiveHeadWindowMs: result is always clamped to [minMs, maxMs]', () => {
    const wav = synth([seg(0.10, -45), seg(1.90, -20)]);
    assert.equal(adaptiveHeadWindowMs(wav, { maxMs: 60 }), 60);
    // degenerate minMs > maxMs: max(minMs, min(maxMs, t)) keeps the lower bound
    assert.equal(adaptiveHeadWindowMs(wav, { minMs: 500, maxMs: 300 }), 500);
});

test('adaptiveHeadWindowMs: unanalysable input falls back to maxMs', () => {
    assert.equal(adaptiveHeadWindowMs(Buffer.alloc(64)), DEFAULTS.maxMs);
    const eightBit = wavFile({ bitsPerSample: 8, data: Buffer.alloc(6000, 128) });
    assert.equal(adaptiveHeadWindowMs(eightBit), DEFAULTS.maxMs);
    const neverGetsUp = synth([seg(0.50, -45), seg(1.50, -20)]);
    assert.equal(adaptiveHeadWindowMs(neverGetsUp, { maxMs: 250 }), 250);
});

// --------------------------------------------------------------------------
// processHead
// --------------------------------------------------------------------------

test('processHead: a clean file comes back unchanged', () => {
    const wav = CRISP();
    const { buffer, diag } = processHead(wav);
    assert.equal(diag.changed, false);
    assert.deepEqual(buffer, wav);
    assert.equal(diag.trim.code, 'no-valley');
    assert.equal(diag.head.skipped, true);
    assert.equal(diag.head.code, 'onset-at-head');
});

test('processHead: step 2 runs on the already trimmed audio', () => {
    const wav = FIAT_WIDE();
    const { buffer, diag } = processHead(wav);
    assert.equal(diag.trim.trimmed, true);
    assert.equal(diag.changed, true);
    const trimmed = trimLeadingAspiration(wav).buffer;
    assert.equal(diag.head.adaptiveWindowMs, adaptiveHeadWindowMs(trimmed));
    assert.notEqual(adaptiveHeadWindowMs(wav), adaptiveHeadWindowMs(trimmed));
    assert.equal(buffer.length, trimmed.length);
});

test('processHead: attenuates the head when the window is long enough', () => {
    const wav = quietBreathHead();
    const { buffer, diag } = processHead(wav);
    assert.equal(diag.trim.code, 'no-valley');
    assert.equal(diag.head.skipped, false);
    assert.ok(diag.head.adaptiveWindowMs > DEFAULTS.minMs, 'window ' + diag.head.adaptiveWindowMs);
    assert.equal(diag.head.ms, diag.head.adaptiveWindowMs);
    assert.equal(diag.head.gainDb, -15);
    assert.equal(buffer.length, wav.length);
});

test('processHead: the two stages can be switched off independently', () => {
    const wav = quietBreathHead();
    const noTrim = processHead(wav, { trimAspiration: false });
    assert.equal(noTrim.diag.trim.code, 'disabled');
    assert.equal(noTrim.diag.head.skipped, false);
    assert.deepEqual(noTrim.buffer, attenuateHead(wav, { ms: adaptiveHeadWindowMs(wav) }).buffer);

    const noHead = processHead(FIAT_WIDE(), { headAttenuateEnable: false });
    assert.equal(noHead.diag.head.code, 'disabled');
    assert.deepEqual(noHead.buffer, trimLeadingAspiration(FIAT_WIDE()).buffer);
});

test('processHead: a fixed (non-adaptive) window is honoured', () => {
    const wav = CRISP();
    const { diag, buffer } = processHead(wav, { headAttenuateAdaptive: false, headAttenuateMs: 120 });
    assert.equal(diag.head.skipped, false);
    assert.equal(diag.head.ms, 120);
    assert.equal(diag.head.gainDb, -15);
    assert.deepEqual(buffer, attenuateHead(wav, { ms: 120, gainDb: -15 }).buffer);
});

test('processHead: the window cap accepts the alias, `ms` and `maxMs`', () => {
    const wav = CRISP();
    const fixed = { headAttenuateAdaptive: false };
    const a = processHead(wav, { ...fixed, headAttenuateMs: 120 });
    const b = processHead(wav, { ...fixed, ms: 120 });
    const c = processHead(wav, { ...fixed, maxMs: 200 });
    assert.equal(a.diag.head.ms, 120);
    assert.equal(b.diag.head.ms, 120);
    assert.deepEqual(a.buffer, b.buffer);
    assert.equal(c.diag.head.ms, 200);
    // the alias wins when both are given
    assert.equal(processHead(wav, { ...fixed, headAttenuateMs: 60, ms: 120 }).diag.head.ms, 60);
    // and it caps the adaptive window too
    assert.equal(processHead(quietBreathHead(), { maxMs: 200 }).diag.head.adaptiveWindowMs, 200);
});

test('processHead: plugin-style aliases match the canonical option names', () => {
    const wav = FIAT_WIDE();
    const a = processHead(wav, { trimRiseMin: 0.30, headAttenuateMs: 300, headAttenuateDb: -18, headAttenuateRelDb: 6 });
    const b = processHead(wav, { riseMin: 0.30, ms: 300, gainDb: -18, relDb: 6 });
    assert.equal(a.diag.head.gainDb, -18);
    assert.deepEqual(a.buffer, b.buffer);
});

/** 3.0 s: a quiet breath head (below the utterance RMS − relDb), then speech. */
function quietBreathHead() {
    return synth([seg(0.40, -39), seg(2.60, -20)]);
}

// --------------------------------------------------------------------------
// defaults are the documented ones
// --------------------------------------------------------------------------

test('DEFAULTS: the shipping thresholds are the documented ones', () => {
    assert.equal(DEFAULTS.riseMin, 0.30);
    assert.equal(DEFAULTS.headFloorDb, 35);
    assert.equal(DEFAULTS.ratioDeltaDb, 8);
    assert.equal(DEFAULTS.narrowDeltaDb, 5);
    assert.equal(DEFAULTS.preDb, -55);
    assert.equal(DEFAULTS.voicedThrDb, -45);
    assert.equal(DEFAULTS.minVoicedFrames, 4);
    assert.equal(DEFAULTS.frameWinSec, 0.025);
    assert.equal(DEFAULTS.frameHopSec, 0.01);
    assert.equal(DEFAULTS.winFrames, 10);
    assert.equal(DEFAULTS.winStepFrames, 5);
    assert.equal(DEFAULTS.minWins, 8);
    assert.equal(DEFAULTS.valleyMarginDb, 20);
    assert.equal(DEFAULTS.valleyMinWins, 3);
    assert.equal(DEFAULTS.valleySearchSec, 1.5);
    assert.equal(DEFAULTS.voiceRefMarginDb, 8);
    assert.equal(DEFAULTS.tailPeakSec, 0.3);
    assert.equal(DEFAULTS.digitalSilDb, -90);
    assert.equal(DEFAULTS.digitalSilSearchSec, 0.5);
    assert.equal(DEFAULTS.cutLeadSec, 0.05);
    assert.equal(DEFAULTS.maxTrimRatio, 0.30);
    assert.equal(DEFAULTS.minDurationDivisor, 4);
    assert.equal(DEFAULTS.ms, 300);
    assert.equal(DEFAULTS.gainDb, -15);
    assert.equal(DEFAULTS.fadeMs, 40);
    assert.equal(DEFAULTS.maxMs, 300);
    assert.equal(DEFAULTS.relDb, 6);
    assert.equal(DEFAULTS.stepMs, 20);
    assert.equal(DEFAULTS.scanMs, 500);
    assert.equal(DEFAULTS.minMs, 40);
    assert.equal(DEFAULTS.trimAspiration, true);
    assert.equal(DEFAULTS.headAttenuateEnable, true);
    assert.equal(DEFAULTS.headAttenuateAdaptive, true);
    assert.equal(DEFAULTS.strict, false);
    assert.ok(Object.isFrozen(DEFAULTS));
});

test('head() helper self-check', () => {
    assert.equal(head(CRISP()).length, 44 + 6400);
});
