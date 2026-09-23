/**
 * wav-head-trim — head-of-utterance processing for synthesised WAV speech.
 *
 * The module is a pure algorithm layer: it works exclusively on `Buffer` /
 * `Uint8Array` values, never touches the filesystem, never mutates its input
 * and has zero dependencies (Node built-ins only).
 *
 * Three operations, in the order a TTS post-processor should apply them:
 *
 *   1. `trimLeadingAspiration(buffer, opts)` — cut a slow-rising leading
 *      aspiration (a long breath-in before the first real word) off the head
 *      of the file. Only fires when a silent valley inside the first
 *      `valleySearchSec` proves that the head stretch really is breath/pause
 *      rather than a genuinely quiet onset.
 *   2. `adaptiveHeadWindowMs(buffer, opts)` — how many milliseconds at the head
 *      are worth attenuating: scan forward until the level "gets up" (two
 *      consecutive frames above whole-utterance RMS − `relDb`); if it never
 *      gets up inside `scanMs`, fall back to the full `maxMs` window.
 *   3. `attenuateHead(buffer, opts)` — attenuate exactly that head window by
 *      `gainDb`, with a linear fade out over the last `fadeMs` so no click is
 *      introduced. Nothing after the window is touched.
 *
 * `processHead(buffer, opts)` runs the three of them in that order (1 → 2 → 3).
 *
 * © 2026 an94 — MIT.
 */

/** Canonical 16-bit PCM mono header written by the trim step. */
const HEADER_BYTES = 44;

/** All tunables. Every value here is the shipped default. */
export const DEFAULTS = Object.freeze({
    // ---- trimLeadingAspiration ----
    /** rise time (s) of the first voiced stretch at/above which trimming is considered. */
    riseMin: 0.30,
    /** head peak must be at least (window median − this) dB, else there is nothing to trim. */
    headFloorDb: 35,
    /** wide gate: tail peak − head peak must reach this many dB. */
    ratioDeltaDb: 8,
    /** narrow gate: delta dB lower bound, combined with the peak-basis head rise. */
    narrowDeltaDb: 5,
    /** dB floor used to decide where the peak-basis head rise starts. */
    preDb: -55,
    /** frames above this level count as "voiced" for the median reference. */
    voicedThrDb: -45,
    /** minimum voiced frames, else the file is judged unanalysable. */
    minVoicedFrames: 4,
    /** per-frame RMS window length (s). */
    frameWinSec: 0.025,
    /** per-frame RMS hop (s). */
    frameHopSec: 0.01,
    /** frames per decision window. */
    winFrames: 10,
    /** frame step per decision window. */
    winStepFrames: 5,
    /** minimum number of decision windows. */
    minWins: 8,
    /** a valley window must be at least (window median − this) dB. */
    valleyMarginDb: 20,
    /** consecutive low windows that make a valley (3 × 50 ms ≈ 150 ms). */
    valleyMinWins: 3,
    /** the valley must start inside this many seconds from the head. */
    valleySearchSec: 1.5,
    /** voice onset = first window after the valley reaching (window median − this) dB. */
    voiceRefMarginDb: 8,
    /** tail peak is measured over this many seconds after the voice onset. */
    tailPeakSec: 0.3,
    /** windows at/below this level count as pure digital silence. */
    digitalSilDb: -90,
    /** digital-silence guard only looks at the first this many seconds. */
    digitalSilSearchSec: 0.5,
    /** keep this much audio before the detected voice onset. */
    cutLeadSec: 0.05,
    /** never remove more than this fraction of the file. */
    maxTrimRatio: 0.30,
    /** minimum length = sampleRate / this (i.e. 0.25 s). */
    minDurationDivisor: 4,
    // ---- attenuateHead ----
    /** length of the head window (ms). */
    ms: 300,
    /** gain applied over the head window (dB). */
    gainDb: -15,
    /** linear fade-out at the end of the head window (ms). */
    fadeMs: 40,
    // ---- adaptiveHeadWindowMs ----
    /** upper bound / fallback window (ms). */
    maxMs: 300,
    /** "level is up" threshold relative to whole-utterance RMS (dB). */
    relDb: 6,
    /** scan step (ms). */
    stepMs: 20,
    /** how far to scan (ms). */
    scanMs: 500,
    /** lower bound of the adaptive window (ms). */
    minMs: 40,
    // ---- processHead switches (the plugin-style aliases below win when set) ----
    /** run step 1. */
    trimAspiration: true,
    /** run steps 2 + 3. */
    headAttenuateEnable: true,
    /** use the adaptive window instead of the fixed `headAttenuateMs`. */
    headAttenuateAdaptive: true,
    /** throw instead of returning the input unchanged on unsupported input. */
    strict: false,
});

/** Raised for input that is not a supported 16-bit PCM RIFF/WAVE buffer. */
export class WavFormatError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'WavFormatError';
        this.code = code ?? 'wav-format';
    }
}

function definedOnly(opts) {
    const out = {};
    if (opts === null || typeof opts !== 'object')
        return out;
    for (const [k, v] of Object.entries(opts))
        if (v !== undefined)
            out[k] = v;
    return out;
}

function merge(opts) {
    return { ...DEFAULTS, ...definedOnly(opts) };
}

function toBuffer(input) {
    if (Buffer.isBuffer(input))
        return input;
    if (input instanceof Uint8Array)
        return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (input instanceof ArrayBuffer)
        return Buffer.from(input);
    throw new TypeError('wav-head-trim: expected a Buffer / Uint8Array / ArrayBuffer, got '
        + (input === null ? 'null' : typeof input));
}

const msg = (e) => (e && e.message ? e.message : String(e));

/**
 * Walk the RIFF chunk list. Deliberately as permissive as the original
 * implementation: no extra bounds guards, so a malformed file surfaces the very
 * same failure (a `RangeError` plus `{ ok: false }`) on both paths.
 */
function scanWav(b) {
    if (b.length < HEADER_BYTES || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE')
        return { ok: false, code: 'not-riff-wave' };
    let off = 12, fmt = null, dataOffset = -1, dataLength = 0;
    const chunks = [];
    while (off + 8 <= b.length) {
        const id = b.toString('ascii', off, off + 4);
        const size = b.readUInt32LE(off + 4);
        const body = off + 8;
        chunks.push({ id, offset: off, size, bodyOffset: body });
        if (id === 'fmt ') {
            fmt = {
                formatTag: b.readUInt16LE(body),
                channels: b.readUInt16LE(body + 2),
                sampleRate: b.readUInt32LE(body + 4),
                byteRate: b.readUInt32LE(body + 8),
                blockAlign: b.readUInt16LE(body + 12),
                bitsPerSample: b.readUInt16LE(body + 14),
            };
        }
        else if (id === 'data') {
            dataOffset = body;
            dataLength = Math.min(size, Math.max(0, b.length - body));
        }
        off = body + size + (size % 2);
    }
    if (fmt === null || dataOffset < 0)
        return { ok: false, code: 'missing-fmt-data', chunks };
    return {
        ok: true,
        chunks,
        fmt,
        dataOffset,
        dataLength,
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bitsPerSample,
    };
}

/**
 * Parse the RIFF/WAVE layout of `buffer`.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer
 * @returns {{sampleRate:number, channels:number, bitsPerSample:number, formatTag:number,
 *            dataOffset:number, dataLength:number, blockAlign:number, byteRate:number,
 *            byteLength:number, totalSamples:number, totalFrames:number,
 *            durationSec:number, chunks:Array<{id:string,offset:number,size:number,bodyOffset:number}>}}
 * @throws {WavFormatError} not RIFF/WAVE, missing `fmt `/`data`, truncated, not
 *         PCM (format tag 1) or not 16-bit.
 * @throws {TypeError} `buffer` is not a Buffer / Uint8Array / ArrayBuffer.
 */
export function parseWav(buffer) {
    const b = toBuffer(buffer);
    let L;
    try {
        L = scanWav(b);
    }
    catch (e) {
        throw new WavFormatError('wav-head-trim: malformed WAV (' + msg(e) + ')', 'malformed');
    }
    if (!L.ok) {
        throw new WavFormatError('wav-head-trim: '
            + (L.code === 'not-riff-wave'
                ? 'not a RIFF/WAVE file (need at least 44 bytes starting with RIFF....WAVE)'
                : 'no fmt or data chunk'),
            L.code);
    }
    if (L.fmt.formatTag !== 1) {
        throw new WavFormatError('wav-head-trim: only PCM (format tag 1) is supported, got format tag '
            + L.fmt.formatTag, 'unsupported-format');
    }
    if (L.bitsPerSample !== 16) {
        throw new WavFormatError('wav-head-trim: only 16-bit PCM is supported, got '
            + L.bitsPerSample + '-bit', 'unsupported-format');
    }
    const ch = L.channels === 0 ? 1 : L.channels;
    const totalSamples = Math.floor(L.dataLength / 2);
    return {
        sampleRate: L.sampleRate,
        channels: L.channels,
        bitsPerSample: L.bitsPerSample,
        formatTag: L.fmt.formatTag,
        byteRate: L.fmt.byteRate,
        blockAlign: L.fmt.blockAlign,
        dataOffset: L.dataOffset,
        dataLength: L.dataLength,
        byteLength: b.length,
        totalSamples,
        totalFrames: Math.floor(totalSamples / ch),
        durationSec: totalSamples / ch / L.sampleRate,
        chunks: L.chunks,
    };
}

/**
 * Full head analysis. Returns every intermediate number the two decision
 * functions use, so callers can explain a decision without re-deriving it.
 *
 * @param {Buffer} b
 * @param {object} o merged options
 */
function analyzeHead(b, o) {
    const m = {
        ok: false,
        code: null,
        reason: null,
        trimmed: false,
        framesDb: null,
        windows: null,
        sampleRate: null,
        channels: null,
        bitsPerSample: null,
        dataOffset: null,
        dataLength: null,
        totalSamples: null,
        durationSec: null,
        frameWinSamples: null,
        frameHopSamples: null,
        frameCount: null,
        voicedFrameCount: null,
        refDb: null,
        winFrames: o.winFrames,
        winStepFrames: o.winStepFrames,
        winCount: null,
        winRefDb: null,
        valleyThrDb: null,
        valleyFound: false,
        valleyStartWinIndex: null,
        valleyEndWinIndex: null,
        valleyStartSec: null,
        valleyEndSec: null,
        headPeakDb: null,
        headWinCount: null,
        tVoiceSec: null,
        tailPeakDb: null,
        riseTimeSec: null,
        headRiseSec: null,
        deltaDb: null,
        widePass: false,
        narrowPass: false,
        headDigitalSilence: false,
        cutSample: null,
        cutSec: null,
        cutRatio: null,
        newTotalSamples: null,
        newDurationSec: null,
        narrow: false,
    };
    const L = scanWav(b);
    if (!L.ok) {
        m.code = L.code;
        m.reason = L.code === 'not-riff-wave' ? 'not a RIFF/WAVE file' : 'missing fmt or data chunk';
        return m;
    }
    const { sampleRate: sr, channels, bitsPerSample, dataOffset, dataLength } = L;
    m.sampleRate = sr;
    m.channels = channels;
    m.bitsPerSample = bitsPerSample;
    m.dataOffset = dataOffset;
    m.dataLength = dataLength;
    if (bitsPerSample !== 16 || channels !== 1) {
        m.code = 'unsupported-format';
        m.reason = 'only 16-bit mono PCM is supported (got ' + bitsPerSample + 'bit/' + channels + 'ch)';
        return m;
    }
    m.ok = true;
    const total = Math.floor(dataLength / 2);
    m.totalSamples = total;
    m.durationSec = total / sr;
    if (total < sr / o.minDurationDivisor) {
        m.code = 'audio-too-short';
        m.reason = 'audio too short';
        return m;
    }

    // Per-frame RMS in dB: `frameWinSec` window, `frameHopSec` hop.
    const win = Math.max(1, Math.round(sr * o.frameWinSec));
    const hop = Math.max(1, Math.round(sr * o.frameHopSec));
    m.frameWinSamples = win;
    m.frameHopSamples = hop;
    const frameCount = Math.floor((total - win) / hop) + 1;
    m.frameCount = frameCount;
    if (frameCount <= 2) {
        m.code = 'too-few-frames';
        m.reason = 'not enough frames';
        return m;
    }
    const dbs = new Float64Array(frameCount);
    for (let k = 0; k < frameCount; k++) {
        const s = k * hop;
        let sum = 0;
        for (let i = s; i < s + win; i++) {
            const v = b.readInt16LE(dataOffset + i * 2) / 32768;
            sum += v * v;
        }
        dbs[k] = 20 * Math.log10(Math.sqrt(sum / win) + 1e-12);
    }
    m.framesDb = dbs;
    const tf = (k) => (k * hop) / sr;   // frame index -> seconds (hop, not 1)

    // Reference level: median of the voiced frames.
    const voiced = [];
    for (let k = 0; k < frameCount; k++)
        if (dbs[k] > o.voicedThrDb)
            voiced.push(dbs[k]);
    m.voicedFrameCount = voiced.length;
    if (voiced.length < o.minVoicedFrames) {
        m.code = 'no-voiced-frames';
        m.reason = 'almost no voiced frames';
        return m;
    }
    voiced.sort((x, y) => x - y);
    const refDb = voiced[Math.floor(voiced.length * 0.5)];
    m.refDb = refDb;

    // Decision windows: median of `winFrames` frames every `winStepFrames`.
    const W = o.winFrames, S = o.winStepFrames;
    const wins = [];
    for (let k = 0; k + W <= frameCount; k += S) {
        const part = dbs.slice(k, k + W).sort();
        wins.push({ tSec: tf(k), db: part[Math.floor(W / 2)] });
    }
    m.windows = wins;
    m.winCount = wins.length;
    if (wins.length < o.minWins) {
        m.code = 'too-few-windows';
        m.reason = 'audio too short (not enough windows)';
        return m;
    }
    const wSorted = wins.map((w) => w.db).sort((a, b) => a - b);
    const wRef = wSorted[Math.floor(wSorted.length * 0.5)];
    const valleyThr = wRef - o.valleyMarginDb;
    m.winRefDb = wRef;
    m.valleyThrDb = valleyThr;

    // (1) First silent valley inside the head: `valleyMinWins` consecutive low
    //     windows (~150 ms of true pause).
    let gi = -1, gj = -1;
    const need = o.valleyMinWins;
    for (let i = 0; i + need <= wins.length; i++) {
        if (wins[i].tSec > o.valleySearchSec)
            break;
        let low = true;
        for (let j = 0; j < need; j++) {
            if (wins[i + j].db > valleyThr) { low = false; break; }
        }
        if (low) {
            gi = i;
            gj = i + need;
            while (gj < wins.length && wins[gj].db <= valleyThr)
                gj++;
            break;
        }
    }
    m.valleyStartWinIndex = gi >= 0 ? gi : null;
    m.valleyEndWinIndex = gi >= 0 ? gj : null;
    if (gi >= 0) {
        m.valleyStartSec = wins[gi].tSec;
        m.valleyEndSec = gj < wins.length ? wins[gj].tSec : null;
    }
    m.valleyFound = gi >= 0 && gj < wins.length;
    if (gi < 0 || gj >= wins.length) {
        m.code = 'no-valley';
        m.reason = 'no silent valley within the first ' + o.valleySearchSec
            + 's => cannot tell a leading aspiration from a quiet onset, not trimmed';
        return m;
    }

    // (2) Head peak (before the valley) vs the voice onset after it.
    let headPeak = -Infinity, headFrames = gi;
    for (let i = 0; i < gi; i++)
        if (wins[i].db > headPeak)
            headPeak = wins[i].db;
    m.headPeakDb = Number.isFinite(headPeak) ? headPeak : null;
    m.headWinCount = headFrames;
    let tVoice = -1;
    for (let i = gj; i < wins.length; i++) {
        if (wins[i].db >= wRef - o.voiceRefMarginDb) {
            tVoice = wins[i].tSec;
            break;
        }
    }
    if (tVoice < 0) {
        m.code = 'no-voice-onset';
        m.reason = 'no voice onset found after the valley';
        return m;
    }
    let tailPeak = -1e9;
    for (let i = gj; i < wins.length; i++) {
        if (wins[i].tSec > tVoice + o.tailPeakSec)
            break;
        if (wins[i].db > tailPeak)
            tailPeak = wins[i].db;
    }
    const riseTime = tVoice;
    m.tVoiceSec = tVoice;
    m.tailPeakDb = tailPeak;
    m.riseTimeSec = riseTime;

    // (3) Guards: digital silence / no measurable head / head too weak.
    let headDigitalSil = false;
    for (let i = 0; i < wins.length; i++) {
        if (wins[i].tSec > o.digitalSilSearchSec)
            break;
        if (wins[i].db <= o.digitalSilDb) { headDigitalSil = true; break; }
    }
    m.headDigitalSilence = headDigitalSil;
    if (headDigitalSil) {
        m.code = 'digital-silence';
        m.reason = 'head contains pure digital silence (<=' + o.digitalSilDb
            + ' dB) => that stretch is a pause, not aspiration, not trimmed';
        return m;
    }
    if (headFrames < 1 || !(headPeak >= wRef - o.headFloorDb)) {
        m.code = 'no-measurable-head';
        m.reason = 'no measurable head window or head energy too low (head='
            + (headFrames < 1 ? 'n/a' : headPeak.toFixed(1) + 'dB') + ') => nothing to trim anyway';
        return m;
    }
    if (riseTime < o.riseMin) {
        m.code = 'crisp-onset';
        m.reason = 'rise ' + riseTime.toFixed(2) + 's (crisp onset, normal)';
        return m;
    }

    // (4) Peak-basis head rise + head/tail level difference.
    let headRise = 0;
    {
        let first = -1, peakAt = -1, best = -1e9;
        for (let i = 0; i < gi; i++) {
            if (first < 0 && wins[i].db > o.preDb)
                first = i;
            if (wins[i].db > best) { best = wins[i].db; peakAt = i; }
        }
        if (first >= 0 && peakAt > first)
            headRise = ((peakAt - first) * S * hop) / sr;
    }
    const deltaDb = tailPeak - headPeak;
    m.headRiseSec = headRise;
    m.deltaDb = deltaDb;
    const widePass = deltaDb >= o.ratioDeltaDb;
    const narrowPass = deltaDb >= o.narrowDeltaDb && headRise >= o.riseMin;
    m.widePass = widePass;
    m.narrowPass = narrowPass;
    if (!widePass && !narrowPass) {
        m.code = 'weak-onset';
        m.reason = 'head/tail differ by only ' + deltaDb.toFixed(1) + 'dB (< ' + o.ratioDeltaDb
            + ', head rise ' + headRise.toFixed(2) + 's) => the head is a weak onset, not aspiration';
        return m;
    }

    // (5) Cut point and the "do not trust the verdict" cap.
    const cutSample = Math.max(0, Math.floor((tVoice - o.cutLeadSec) * sr));
    m.cutSample = cutSample;
    m.cutSec = cutSample / sr;
    m.cutRatio = cutSample / total;
    if (cutSample <= 0 || cutSample >= total) {
        m.code = 'cut-out-of-range';
        m.reason = 'cut point out of range';
        return m;
    }
    if (cutSample > total * o.maxTrimRatio) {
        m.code = 'over-cap';
        m.reason = 'cut would remove ' + ((cutSample / total) * 100).toFixed(0)
            + '% which exceeds the ' + (o.maxTrimRatio * 100) + '% cap, giving up';
        return m;
    }
    m.trimmed = true;
    m.code = 'trimmed';
    m.newTotalSamples = total - cutSample;
    m.newDurationSec = m.newTotalSamples / sr;
    m.narrow = narrowPass && !widePass;
    return m;
}

/** Public diagnostic view of an analysis (the field names of the original API are kept). */
function trimDiag(m, opts) {
    const d = { changed: m.trimmed, trimmed: m.trimmed, code: m.code, reason: m.reason };
    if (m.riseTimeSec !== null)
        d.riseTime = m.riseTimeSec;
    if (m.trimmed) {
        d.narrow = m.narrow;
        d.cut = +(m.cutSample / m.sampleRate).toFixed(2);
        d.oldSeconds = +(m.totalSamples / m.sampleRate).toFixed(2);
        d.newSeconds = +(m.newTotalSamples / m.sampleRate).toFixed(2);
    }
    d.strict = !!opts.strict;
    d.sampleRate = m.sampleRate;
    d.durationSec = m.durationSec;
    d.deltaDb = m.deltaDb;
    d.headRiseSec = m.headRiseSec;
    d.headPeakDb = m.headPeakDb;
    d.tailPeakDb = m.tailPeakDb;
    d.valleyStartSec = m.valleyStartSec;
    d.valleyEndSec = m.valleyEndSec;
    d.headDigitalSilence = m.headDigitalSilence;
    d.cutSample = m.cutSample;
    d.cutRatio = m.cutRatio;
    d.newTotalSamples = m.newTotalSamples;
    return d;
}

/** Build the canonical 44-byte-header file with the head removed. */
function buildTrimmed(b, m) {
    const sr = m.sampleRate;
    const cutSample = m.cutSample;
    const newTotal = m.newTotalSamples;
    const out = Buffer.alloc(HEADER_BYTES + newTotal * 2);
    out.write('RIFF', 0);
    out.writeUInt32LE(36 + newTotal * 2, 4);
    out.write('WAVE', 8);
    out.write('fmt ', 12);
    out.writeUInt32LE(16, 16);
    out.writeUInt16LE(1, 20);
    out.writeUInt16LE(1, 22);
    out.writeUInt32LE(sr, 24);
    out.writeUInt32LE(sr * 2, 28);
    out.writeUInt16LE(2, 32);
    out.writeUInt16LE(16, 34);
    out.write('data', 36);
    out.writeUInt32LE(newTotal * 2, 40);
    b.copy(out, HEADER_BYTES, m.dataOffset + cutSample * 2, m.dataOffset + cutSample * 2 + newTotal * 2);
    return out;
}

/**
 * Diagnose the head of a 16-bit PCM mono WAV without changing anything.
 *
 * The returned object carries the valley position, the head/tail peaks, the
 * per-window dB curve, the rise times and the final decision. Field reference
 * is in the README.
 *
 * @throws {WavFormatError} unsupported or malformed input (this entry point is
 *         strict on purpose; the processing functions are the lenient layer).
 */
export function headMetrics(buffer, opts) {
    const o = merge(opts);
    const b = toBuffer(buffer);
    let m;
    try {
        m = analyzeHead(b, o);
    }
    catch (e) {
        throw new WavFormatError('wav-head-trim: malformed WAV (' + msg(e) + ')', 'malformed');
    }
    if (!m.ok)
        throw new WavFormatError('wav-head-trim: ' + m.reason, m.code);
    return m;
}

/**
 * Remove a slow-rising leading aspiration from a 16-bit PCM mono WAV.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer
 * @param {object} [opts] see {@link DEFAULTS}
 * @returns {{buffer: Buffer, diag: object}} a NEW buffer (the input is never
 *          modified). `diag.trimmed` tells whether anything was removed.
 * @throws {TypeError} `buffer` is not a Buffer / Uint8Array / ArrayBuffer.
 * @throws {WavFormatError} only with `opts.strict === true`.
 */
export function trimLeadingAspiration(buffer, opts) {
    const o = merge(opts);
    const b = toBuffer(buffer);
    let m;
    try {
        m = analyzeHead(b, o);
    }
    catch (e) {
        if (o.strict)
            throw new WavFormatError('wav-head-trim: malformed WAV (' + msg(e) + ')', 'malformed');
        m = { ok: false, code: 'malformed', reason: msg(e), trimmed: false, riseTimeSec: null };
    }
    if (!m.ok && o.strict)
        throw new WavFormatError('wav-head-trim: ' + m.reason, m.code);
    const diag = trimDiag(m, o);
    return { buffer: m.trimmed ? buildTrimmed(b, m) : Buffer.from(b), diag };
}

/**
 * Attenuate the first `ms` milliseconds of a 16-bit PCM WAV by `gainDb`,
 * fading the gain back to 1 over the last `fadeMs` of the window.
 *
 * Multi-channel 16-bit PCM is supported (every channel of a frame gets the
 * same gain); nothing outside the window is touched.
 *
 * @returns {{buffer: Buffer, diag: object}} a NEW buffer; `diag.ok` is false
 *          when the input is not 16-bit PCM.
 * @throws {TypeError} `buffer` is not a Buffer / Uint8Array / ArrayBuffer.
 * @throws {WavFormatError} only with `opts.strict === true`.
 */
export function attenuateHead(buffer, opts) {
    const o = merge(opts);
    const b = toBuffer(buffer);
    let L;
    try {
        L = scanWav(b);
    }
    catch (e) {
        if (o.strict)
            throw new WavFormatError('wav-head-trim: malformed WAV (' + msg(e) + ')', 'malformed');
        return {
            buffer: Buffer.from(b),
            diag: { ok: false, changed: false, code: 'malformed', reason: msg(e), ms: o.ms, gainDb: o.gainDb },
        };
    }
    if (!L.ok || L.bitsPerSample !== 16) {
        if (o.strict)
            throw new WavFormatError('wav-head-trim: only 16-bit PCM is supported (got '
                + (L.ok ? L.bitsPerSample + '-bit' : L.code) + ')', 'unsupported-format');
        return {
            buffer: Buffer.from(b),
            diag: {
                ok: false,
                changed: false,
                code: L.ok ? 'unsupported-format' : L.code,
                reason: 'only 16-bit PCM is supported (' + (L.ok ? L.bitsPerSample + 'bit' : 'no fmt') + ')',
                ms: o.ms,
                gainDb: o.gainDb,
            },
        };
    }
    const sr = L.sampleRate, ch = L.channels, dataOffset = L.dataOffset, dataLen = L.dataLength;
    const n = Math.min(Math.floor(sr * o.ms / 1000), Math.floor(dataLen / 2 / ch));
    const fade = Math.max(1, Math.floor(sr * o.fadeMs / 1000));
    const g = Math.pow(10, o.gainDb / 20);
    const out = Buffer.from(b);
    for (let k = 0; k < n; k++) {
        const w = k < n - fade ? 1 : Math.max(0, (n - k) / fade);
        const gg = 1 + (g - 1) * w;
        for (let c = 0; c < ch; c++) {
            const idx = dataOffset + (k * ch + c) * 2;
            if (idx + 1 >= out.length)
                break;
            let v = out.readInt16LE(idx);
            v = Math.max(-32768, Math.min(32767, Math.round(v * gg)));
            out.writeInt16LE(v, idx);
        }
    }
    return {
        buffer: out,
        diag: {
            ok: true,
            changed: n > 0 && g !== 1,
            ms: o.ms,
            gainDb: o.gainDb,
            fadeMs: o.fadeMs,
            sampleRate: sr,
            channels: ch,
            samplesPerChannel: n,
            fadeSamples: fade,
            gain: g,
        },
    };
}

/**
 * Length (ms) of the head window worth attenuating.
 *
 * Scan forward from 0 in `stepMs` steps and stop at the first position where
 * two consecutive frames both exceed (whole-utterance RMS − `relDb`) — the
 * moment the level "gets up" (voice onset). If that never happens inside
 * `scanMs` (typical for a purely breathy head), fall back to the full `maxMs`.
 * The result is always clamped to [`minMs`, `maxMs`], so it can only ever be
 * shorter — never more aggressive — than a fixed window.
 *
 * @returns {number} milliseconds; `maxMs` when the buffer cannot be analysed.
 * @throws {TypeError} `buffer` is not a Buffer / Uint8Array / ArrayBuffer.
 */
export function adaptiveHeadWindowMs(buffer, opts) {
    const o = merge(opts);
    const maxMs = o.maxMs;
    const b = toBuffer(buffer);
    try {
        const L = scanWav(b);
        if (!L.ok || L.bitsPerSample !== 16)
            return maxMs;
        const ch = L.channels, sr = L.sampleRate, dataOffset = L.dataOffset, dataLen = L.dataLength;
        const totalMs = dataLen / 2 / ch / sr * 1000;
        const rmsDb = (startMs, durMs) => {
            const start = Math.floor(sr * startMs / 1000);
            const n = Math.floor(sr * durMs / 1000);
            let sum = 0, cnt = 0;
            for (let k = start; k < start + n; k++) {
                for (let c = 0; c < ch; c++) {
                    const i = dataOffset + (k * ch + c) * 2;
                    if (i + 1 >= dataOffset + dataLen)
                        break;
                    const v = b.readInt16LE(i) / 32768;
                    sum += v * v;
                    cnt++;
                }
            }
            return cnt > 0 ? 20 * Math.log10(Math.sqrt(sum / cnt)) : -999;
        };
        const thr = rmsDb(0, totalMs) - o.relDb;
        const limit = Math.min(o.scanMs, totalMs) - 2 * o.stepMs;
        for (let t = 0; t <= limit; t += o.stepMs) {
            if (rmsDb(t, o.stepMs) > thr && rmsDb(t + o.stepMs, o.stepMs) > thr)
                return Math.max(o.minMs, Math.min(maxMs, t));
        }
        return maxMs;
    }
    catch {
        return maxMs;
    }
}

/** Options of `processHead` that belong to step 1. */
const TRIM_KEYS = [
    'riseMin', 'headFloorDb', 'ratioDeltaDb', 'narrowDeltaDb', 'preDb', 'voicedThrDb',
    'minVoicedFrames', 'frameWinSec', 'frameHopSec', 'winFrames', 'winStepFrames', 'minWins',
    'valleyMarginDb', 'valleyMinWins', 'valleySearchSec', 'voiceRefMarginDb', 'tailPeakSec',
    'digitalSilDb', 'digitalSilSearchSec', 'cutLeadSec', 'maxTrimRatio', 'minDurationDivisor', 'strict',
];

function pick(o, keys) {
    const out = {};
    for (const k of keys)
        if (o[k] !== undefined)
            out[k] = o[k];
    return out;
}

/** First argument that is not `undefined` (the last one is the fallback). */
function firstDefined(...vals) {
    for (const v of vals)
        if (v !== undefined)
            return v;
    return undefined;
}

/**
 * Run the whole head pipeline on one buffer, in the shipping order:
 *
 *   1. `trimLeadingAspiration` (if `trimAspiration`),
 *   2. `adaptiveHeadWindowMs` on the **already trimmed** audio (if
 *      `headAttenuateAdaptive`), otherwise the fixed `headAttenuateMs`,
 *   3. `attenuateHead` — skipped when the adaptive window came back at or below
 *      `minMs`, i.e. the voice starts right at the head and there is no breath
 *      to soften.
 *
 * Options are flat. Both the canonical names (`riseMin`, `ms`, `gainDb`,
 * `fadeMs`, `maxMs`, `relDb`) and the plugin-config style aliases
 * (`trimRiseMin`, `headAttenuateMs`, `headAttenuateDb`, `headAttenuateFadeMs`,
 * `headAttenuateRelDb`) are accepted; an alias wins when both are given.
 *
 * @returns {{buffer: Buffer, diag: {changed: boolean, trim: object, head: object}}}
 */
export function processHead(buffer, opts) {
    const o = merge(opts);
    const raw = definedOnly(opts);
    const src = toBuffer(buffer);

    const trimOpts = pick(o, TRIM_KEYS);
    if (o.trimRiseMin !== undefined)
        trimOpts.riseMin = o.trimRiseMin;
    const headOpts = { gainDb: o.gainDb, fadeMs: o.fadeMs, strict: o.strict };
    if (o.headAttenuateDb !== undefined)
        headOpts.gainDb = o.headAttenuateDb;
    if (o.headAttenuateFadeMs !== undefined)
        headOpts.fadeMs = o.headAttenuateFadeMs;
    const adaptOpts = { relDb: o.relDb, stepMs: o.stepMs, scanMs: o.scanMs, minMs: o.minMs };
    if (o.headAttenuateRelDb !== undefined)
        adaptOpts.relDb = o.headAttenuateRelDb;
    // Window cap, in priority order: plugin-style alias -> `ms` -> `maxMs` -> default.
    const capMs = firstDefined(raw.headAttenuateMs, raw.ms, raw.maxMs, DEFAULTS.ms);
    headOpts.ms = capMs;
    adaptOpts.maxMs = capMs;

    let cur = src;
    let trimDiag;
    if (o.trimAspiration === false) {
        trimDiag = { changed: false, trimmed: false, code: 'disabled', reason: 'trim disabled' };
    }
    else {
        const r = trimLeadingAspiration(cur, trimOpts);
        cur = r.buffer;
        trimDiag = r.diag;
    }

    let headDiag;
    if (o.headAttenuateEnable === false) {
        headDiag = { ok: false, changed: false, skipped: true, code: 'disabled', reason: 'head attenuation disabled' };
    }
    else {
        const windowMs = o.headAttenuateAdaptive === false
            ? capMs
            : adaptiveHeadWindowMs(cur, adaptOpts);
        if (o.headAttenuateAdaptive !== false && windowMs <= o.minMs) {
            headDiag = {
                ok: true,
                changed: false,
                skipped: true,
                adaptiveWindowMs: windowMs,
                code: 'onset-at-head',
                reason: 'voice onset right at the head (window <= ' + o.minMs + 'ms), not attenuated',
            };
        }
        else {
            const r = attenuateHead(cur, { ...headOpts, ms: windowMs });
            cur = r.buffer;
            headDiag = { ...r.diag, skipped: false, adaptiveWindowMs: windowMs };
        }
    }
    const out = cur === src ? Buffer.from(src) : cur;
    return {
        buffer: out,
        diag: { changed: !src.equals(out), trim: trimDiag, head: headDiag },
    };
}
