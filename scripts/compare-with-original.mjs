#!/usr/bin/env node
/**
 * compare-with-original.mjs — byte-for-byte regression harness.
 *
 * Runs the ORIGINAL implementation (the three exported functions of the
 * reference plugin module) and this package's implementation over the same WAV
 * files, then compares the produced bytes:
 *
 *   step 1  trimLeadingAspiration(input, riseMin)
 *   step 2  adaptiveHeadWindowMs(trimmed, maxMs, relDb)
 *   step 3  attenuateHead(trimmed, windowMs, gainDb)   // skipped when window <= minMs
 *
 * The original functions take a PATH and rewrite that file in place, so every
 * input is copied into a scratch directory first; the corpus itself is only
 * ever read.
 *
 * Usage:
 *   node scripts/compare-with-original.mjs [options] <dir> [<dir> ...]
 *
 * Options:
 *   --original <file>   path of the reference module (default: auto-detected
 *                       under the current user profile, see README)
 *   --no-recursive      do not descend into sub-directories
 *   --rise-min <s>      trim rise threshold        (default 0.30)
 *   --cap-ms <ms>       head attenuation cap/window (default 300)
 *   --gain-db <db>      head attenuation gain       (default -15)
 *   --rel-db <db>       adaptive window relDb       (default 6)
 *   --max-report <n>    how many differing files to list in detail (default 20)
 *   --json              also print a machine-readable summary
 *
 * Exit code: 0 when everything matches, 1 when at least one file differs,
 *            2 when the run is INCONCLUSIVE (a corpus directory could not be
 *            read, or no WAV was compared at all) — a comparison that never
 *            happened must not be reported as a pass.
 *
 * © 2026 an94 — MIT.
 */
import { spawn } from 'node:child_process';
import {
    mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from 'node:net';

import * as wht from '../lib/index.js';

const NEEDED = ['trimLeadingAspiration', 'attenuateHead', 'adaptiveHeadWindowMs'];

const OPTS = {
    original: null,
    recursive: true,
    riseMin: 0.30,
    capMs: 300,
    gainDb: -15,
    relDb: 6,
    minMs: wht.DEFAULTS.minMs,
    maxReport: 20,
    json: false,
    dirs: [],
};

function parseArgs(argv) {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const take = (name) => {
            const v = argv[++i];
            if (v === undefined)
                throw new Error('missing value for ' + name);
            return v;
        };
        if (a === '--original')
            OPTS.original = take(a);
        else if (a.startsWith('--original='))
            OPTS.original = a.slice('--original='.length);
        else if (a === '--no-recursive')
            OPTS.recursive = false;
        else if (a === '--rise-min')
            OPTS.riseMin = Number(take(a));
        else if (a === '--cap-ms')
            OPTS.capMs = Number(take(a));
        else if (a === '--gain-db')
            OPTS.gainDb = Number(take(a));
        else if (a === '--rel-db')
            OPTS.relDb = Number(take(a));
        else if (a === '--max-report')
            OPTS.maxReport = Number(take(a));
        else if (a === '--json')
            OPTS.json = true;
        else if (a.startsWith('-'))
            throw new Error('unknown option ' + a);
        else
            OPTS.dirs.push(a);
    }
    if (OPTS.original === null)
        OPTS.original = process.env.WHT_ORIGINAL_PLUGIN || null;
}

// ---------------------------------------------------------------------------
// locate + load the reference implementation
// ---------------------------------------------------------------------------

/** Look for the reference module under the current user profile (no path is hard-coded). */
function autoDetectOriginal() {
    const roots = [];
    const profiles = join(homedir(), '.dsh', 'profiles');
    try {
        for (const p of readdirSync(profiles))
            roots.push(join(profiles, p, 'local-plugins', 'dsh-voice-local', 'lib', 'index.js'));
    }
    catch { /* profile dir absent — nothing to auto-detect */ }
    for (const r of roots) {
        try {
            if (statSync(r).isFile())
                return r;
        }
        catch { /* keep looking */ }
    }
    return null;
}

/**
 * Fallback loader: pull every top-level `function name(...) {...}` out of a
 * source file and evaluate it, for a module that does not export what we need
 * (or cannot be imported at all).
 */
function loadBySourceExtraction(file) {
    const src = readFileSync(file, 'utf8');
    const decls = new Map();
    const re = /(^|\n)[ \t]*(?:export[ \t]+)?(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)[ \t]*\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const start = m.index + m[1].length;
        if (decls.has(m[2]))
            continue;
        const bodyEnd = matchFunctionEnd(src, m.index + m[0].length - 1);
        if (bodyEnd < 0)
            continue;
        decls.set(m[2], src.slice(start, bodyEnd + 1));
        re.lastIndex = bodyEnd;
    }
    const missing = NEEDED.filter((n) => !decls.has(n));
    if (missing.length > 0)
        throw new Error('could not extract ' + missing.join(', ') + ' from ' + basename(file));
    const code = [...decls.values()].join('\n\n')
        + '\nreturn { ' + NEEDED.join(', ') + ' };';
    // eslint-disable-next-line no-new-func
    const factory = new Function(
        'readFileSync', 'writeFileSync', 'Buffer', 'spawn', 'connect', 'resolve', 'isAbsolute',
        'dirname', 'mkdirSync', 'statSync', 'process', code);
    return factory(readFileSync, writeFileSync, Buffer, spawn, connect, resolve, isAbsolute,
        dirname, mkdirSync, statSync, process);
}

/** Index of the `}` closing the body of the function whose `(` sits at `parenAt`. */
function matchFunctionEnd(src, parenAt) {
    let i = parenAt, depth = 0;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '(')
            depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0)
                break;
        }
    }
    let j = src.indexOf('{', i);
    if (j < 0)
        return -1;
    let braces = 0;
    for (; j < src.length; j++) {
        const c = src[j];
        const next = src[j + 1];
        if (c === '/' && next === '/') {
            while (j < src.length && src[j] !== '\n')
                j++;
            continue;
        }
        if (c === '/' && next === '*') {
            j += 2;
            while (j < src.length && !(src[j] === '*' && src[j + 1] === '/'))
                j++;
            j++;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            const quote = c;
            j++;
            while (j < src.length) {
                if (src[j] === '\\') { j += 2; continue; }
                if (src[j] === quote)
                    break;
                j++;
            }
            continue;
        }
        if (c === '{')
            braces++;
        else if (c === '}') {
            braces--;
            if (braces === 0)
                return j;
        }
    }
    return -1;
}

async function loadOriginal(file) {
    if (file !== null) {
        try {
            const mod = await import(pathToFileURL(file).href);
            if (NEEDED.every((n) => typeof mod[n] === 'function'))
                return { impl: mod, how: 'module exports' };
        }
        catch (e) {
            // fall through to source extraction
            var importError = e;
        }
        const extracted = loadBySourceExtraction(file);
        return {
            impl: extracted,
            how: 'source extraction fallback'
                + (importError ? ' (import failed: ' + importError.message + ')' : ' (functions not exported)'),
        };
    }
    return null;
}

// ---------------------------------------------------------------------------
// corpus walk
// ---------------------------------------------------------------------------

/** How many corpus directories could not be read (makes the run inconclusive). */
let unreadableDirs = 0;

function collectWavs(dir, recursive, out) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch (e) {
        unreadableDirs++;
        console.error('cannot read directory: ' + e.message);
        return out;
    }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
            if (recursive)
                collectWavs(p, recursive, out);
        }
        else if (e.isFile() && e.name.toLowerCase().endsWith('.wav'))
            out.push(p);
    }
    return out;
}

// ---------------------------------------------------------------------------
// one file, both implementations
// ---------------------------------------------------------------------------

const near = (a, b) => {
    const x = a === undefined ? null : a;
    const y = b === undefined ? null : b;
    return x === y;
};

function diagDiff(origDiag, newDiag, keys) {
    const bad = [];
    for (const k of keys)
        if (!near(origDiag?.[k], newDiag?.[k]))
            bad.push(k + ':' + JSON.stringify(origDiag?.[k] ?? null) + '!=' + JSON.stringify(newDiag?.[k] ?? null));
    return bad;
}

function firstDiffOffset(a, b) {
    if (a.length !== b.length)
        return Math.min(a.length, b.length);
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            return i;
    return -1;
}

/** Describe the first differing byte of two buffers (or the length difference). */
function describeDiff(a, b, off) {
    if (a.length !== b.length && off >= Math.min(a.length, b.length))
        return 'length differs by ' + Math.abs(a.length - b.length) + 'B';
    return 'byte@' + off + ' orig=0x' + (a[off] ?? 0).toString(16).padStart(2, '0')
        + ' new=0x' + (b[off] ?? 0).toString(16).padStart(2, '0');
}

function compareOne(orig, workFile, input) {
    // ---- original: step 1, then steps 2+3, both rewriting workFile in place
    writeFileSync(workFile, input);
    let origTrimDiag;
    try {
        origTrimDiag = orig.trimLeadingAspiration(workFile, OPTS.riseMin);
    }
    catch (e) {
        origTrimDiag = { trimmed: false, reason: 'threw: ' + e.message };
    }
    const origAfterTrim = readFileSync(workFile);
    let origWindowMs = null, origHeadDiag = null, skipped = false;
    try {
        origWindowMs = orig.adaptiveHeadWindowMs(workFile, OPTS.capMs, OPTS.relDb);
        if (origWindowMs <= OPTS.minMs)
            skipped = true;
        else
            origHeadDiag = orig.attenuateHead(workFile, origWindowMs, OPTS.gainDb);
    }
    catch (e) {
        origHeadDiag = { ok: false, reason: 'threw: ' + e.message };
    }
    const origAfterHead = readFileSync(workFile);

    // ---- this package: same order, buffers instead of files
    const newTrim = wht.trimLeadingAspiration(input, { riseMin: OPTS.riseMin });
    const newProc = wht.processHead(input, {
        trimRiseMin: OPTS.riseMin,
        headAttenuateEnable: true,
        headAttenuateAdaptive: true,
        headAttenuateMs: OPTS.capMs,
        headAttenuateDb: OPTS.gainDb,
        headAttenuateRelDb: OPTS.relDb,
    });

    const diffs = [];
    const offTrim = firstDiffOffset(origAfterTrim, newTrim.buffer);
    if (offTrim !== -1)
        diffs.push({
            step: 'trim',
            what: describeDiff(origAfterTrim, newTrim.buffer, offTrim),
            origBytes: origAfterTrim.length,
            newBytes: newTrim.buffer.length,
        });
    const offHead = firstDiffOffset(origAfterHead, newProc.buffer);
    if (offHead !== -1)
        diffs.push({
            step: 'head',
            what: describeDiff(origAfterHead, newProc.buffer, offHead),
            origBytes: origAfterHead.length,
            newBytes: newProc.buffer.length,
        });

    const diagBad = []
        .concat(diagDiff(origTrimDiag, newTrim.diag, ['trimmed', 'riseTime', 'narrow', 'cut', 'oldSeconds', 'newSeconds'])
            .map((s) => 'trim.' + s))
        // the original never calls attenuateHead when the window is <= minMs,
        // so there is no head diag to compare in that branch
        .concat(skipped ? [] : diagDiff(origHeadDiag, newProc.diag.head, ['ok', 'ms', 'gainDb']).map((s) => 'head.' + s))
        .concat(near(origWindowMs, newProc.diag.head.adaptiveWindowMs) ? []
            : ['adaptiveWindowMs:' + origWindowMs + '!=' + newProc.diag.head.adaptiveWindowMs])
        .concat(skipped === (newProc.diag.head.skipped === true) ? []
            : ['skipped:' + skipped + '!=' + newProc.diag.head.skipped]);

    return {
        diffs,
        diagBad,
        trimmed: origTrimDiag?.trimmed === true,
        attenuated: !skipped,
        skipped,
        noValley: origTrimDiag?.trimmed === false,
        origTrimDiag,
        newTrimDiag: newTrim.diag,
        origWindowMs,
        newProc,
    };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
    parseArgs(process.argv.slice(2));
    if (OPTS.dirs.length === 0) {
        console.error('usage: node scripts/compare-with-original.mjs [--original <file>] <dir> [<dir> ...]');
        process.exit(2);
    }
    const file = OPTS.original !== null && OPTS.original !== '' ? resolve(OPTS.original) : autoDetectOriginal();
    if (file === null) {
        console.error('no reference module found: pass --original <path-to-index.js> or set WHT_ORIGINAL_PLUGIN');
        process.exit(2);
    }
    const loaded = await loadOriginal(file);
    if (loaded === null) {
        console.error('reference module not usable: ' + file);
        process.exit(2);
    }
    const orig = loaded.impl;

    const files = [];
    for (const d of OPTS.dirs)
        collectWavs(isAbsolute(d) ? d : resolve(d), OPTS.recursive, files);

    const scratch = mkdtempSync(join(tmpdir(), 'wht-compare-'));
    const workFile = join(scratch, 'work.wav');
    mkdirSync(scratch, { recursive: true });

    let identical = 0;
    const different = [];
    const details = [];
    let scanned = 0, unreadable = 0;
    let trimmedN = 0, attenuatedN = 0, skippedN = 0;

    for (const f of files) {
        let input;
        try {
            input = readFileSync(f);
        }
        catch {
            unreadable++;
            continue;
        }
        scanned++;
        const r = compareOne(orig, workFile, input);
        if (r.trimmed)
            trimmedN++;
        if (r.attenuated)
            attenuatedN++;
        else
            skippedN++;
        if (r.diffs.length === 0 && r.diagBad.length === 0)
            identical++;
        else {
            different.push({ file: basename(f), diffs: r.diffs, diagBad: r.diagBad });
            if (details.length < OPTS.maxReport)
                details.push({ file: basename(f), ...r });
        }
    }

    try {
        rmSync(scratch, { recursive: true, force: true });
    }
    catch { /* scratch dir is left behind for inspection */ }

    console.log('wav-head-trim · compare-with-original');
    console.log('original implementation : ' + loaded.how);
    console.log('steps                   : trimLeadingAspiration -> adaptiveHeadWindowMs -> attenuateHead');
    console.log('parameters              : riseMin=' + OPTS.riseMin + ' capMs=' + OPTS.capMs
        + ' gainDb=' + OPTS.gainDb + ' relDb=' + OPTS.relDb + ' minMs=' + OPTS.minMs);
    console.log('directories             : ' + OPTS.dirs.length + ' (' + (OPTS.recursive ? 'recursive' : 'flat') + ')');
    console.log('files scanned           : ' + scanned
        + (unreadable > 0 ? '  (unreadable files: ' + unreadable + ')' : '')
        + (unreadableDirs > 0 ? '  (unreadable dirs: ' + unreadableDirs + ')' : ''));
    console.log('original trimmed        : ' + trimmedN + ' file(s)');
    console.log('original attenuated     : ' + attenuatedN + ' file(s)  (window <= minMs, so step 3 skipped: ' + skippedN + ')');
    console.log('');

    for (const d of details) {
        for (const diff of d.diffs)
            console.log('[different] ' + d.file + ' step=' + diff.step
                + ' ' + diff.what
                + ' orig=' + diff.origBytes + 'B new=' + diff.newBytes + 'B');
        if (d.diffs.length === 0 && d.diagBad.length > 0)
            console.log('[diag-only] ' + d.file + ' ' + d.diagBad.join(' '));
        else if (d.diagBad.length > 0)
            console.log('            ' + d.file + ' diag: ' + d.diagBad.join(' '));
    }
    if (different.length > details.length)
        console.log('... ' + (different.length - details.length) + ' more differing file(s) not listed');

    console.log('');
    console.log('结果：' + scanned + ' 个文件 / 完全一致 ' + identical + ' / 不一致 ' + different.length);
    if (different.length > 0) {
        const byStep = new Map();
        for (const d of different)
            for (const x of d.diffs)
                byStep.set(x.step, (byStep.get(x.step) ?? 0) + 1);
        for (const [step, n] of byStep)
            console.log('  step ' + step + ': ' + n + ' file(s) differ');
    }
    if (OPTS.json) {
        console.log(JSON.stringify({
            original: loaded.how,
            params: {
                riseMin: OPTS.riseMin, capMs: OPTS.capMs, gainDb: OPTS.gainDb, relDb: OPTS.relDb,
            },
            scanned, identical, different: different.length,
            differing: different.map((d) => ({ file: d.file, diffs: d.diffs, diag: d.diagBad })),
        }, null, 2));
    }
    if (scanned === 0 || unreadableDirs > 0 || unreadable > 0) {
        console.error('inconclusive: '
            + (scanned === 0 ? 'no WAV file was compared' : unreadableDirs + ' dir(s) / ' + unreadable + ' file(s) unreadable')
            + ' — refusing to report a pass');
        process.exit(2);
    }
    process.exit(different.length === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('compare-with-original failed: ' + (e && e.stack ? e.stack : e));
    process.exit(2);
});
