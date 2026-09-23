# wav-head-trim

**Zero-dependency ESM helpers for the head of synthesised speech WAV files.** Trim a slow-rising
breath that some TTS/cloning models occasionally prepend, and gently attenuate an over-prominent
aspiration head — over plain `Buffer` / `Uint8Array`, with no I/O of any kind.

## Install

**Not published to npm** — install straight from GitHub (GitHub first, then pin a tag if you care
about reproducibility):

```bash
dsh plugin --profile <profile> add github:an94-code/wav-head-trim
# or pin the release tag:
dsh plugin --profile <profile> add https://codeload.github.com/an94-code/wav-head-trim/tar.gz/refs/tags/v1.0.1
```

> `dsh plugin` forwards its arguments to `pnpm` inside the DSH profile directory, so the `github:` /
> `codeload` forms above are what actually resolve — a bare `pnpm add wav-head-trim` would only work
> once it is published to npm (it is not).

## Usage

```js
import { processHead } from 'wav-head-trim';
import { readFileSync, writeFileSync } from 'node:fs';

const wav = readFileSync('tts.wav');             // 16-bit PCM RIFF/WAVE
const { buffer, diag } = processHead(wav);       // trim + attenuate in one pass

if (diag.changed) writeFileSync('tts.fixed.wav', buffer);
console.log(diag.trim.reason ?? diag.trim.code, diag.head.ms, diag.head.gainDb);
```

> `trimLeadingAspiration` / `attenuateHead` / `adaptiveHeadWindowMs` are also exported individually
> if you want one half of the pipeline. **Inputs are never mutated** — every call returns a new Buffer.

---

零依赖 ESM 小库，只做一件事：**处理 TTS 合成 WAV 的开头那一小截**。

它把三个判据从一份自用的语音合成插件里抽了出来，做成纯函数：

1. **裁掉开头的慢升吸气** —— GPT-SoVITS 一类克隆模型偶发会在最前面生成一段"慢慢涨起来的换气声"，
   爬升慢、又扎耳朵；把它连同前面的停顿一起切掉，不碰后面的正文。
2. **把开头的气压声/爆破声衰减** —— 有些产物开头是纯气流：按音量它并不比正文响（实测低 6–20 dB），
   但听感突出。裁剪治不了它（它和正文的电平差不够大），只能把那一截整体压下去。
3. **自适应头窗** —— 压多少毫秒不写死：从 0 起扫，扫到"电平顶起来"（语音起音）就停；
   扫不到（整句开头全是气流）就回退满窗。返回值恒被夹在 `[minMs, maxMs]`，
   **只会比固定窗口更短，绝不会更狠**。

- ESM、`type: module`、零依赖、无 `dependencies`、不联网、不读写文件。
- 所有函数只对 `Buffer` / `Uint8Array` 操作，**绝不原地改写输入**；返回的永远是新的 Buffer。
- 只认 **16-bit PCM** RIFF/WAVE；其它格式明确报错（见「错误处理」一节）。
- 自带 `node:test` 测试（测试数据全部在代码里合成，不附带任何二进制样本）。
- 自带一个与**另一份参考实现**逐字节对拍的回归工具（`scripts/compare-with-original.mjs`）。

要求：**Node.js >= 18**。

```js
import { processHead, trimLeadingAspiration, attenuateHead, adaptiveHeadWindowMs } from 'wav-head-trim';

const wav = readFileSync('tts.wav');           // 你的 16-bit PCM WAV

const { buffer, diag } = processHead(wav);     // 裁 + 压，一次做完
if (diag.changed) writeFileSync('tts.fixed.wav', buffer);
console.log(diag.trim.reason ?? diag.trim.code, diag.head.ms, diag.head.gainDb);
```

---

## 1. 算法判据

### 1.1 帧与窗

| 量 | 定义 | 缺省 |
| --- | --- | --- |
| 帧 (frame) | 窗内 RMS 转 dB：`20*log10(sqrt(sum(v²)/win) + 1e-12)`，`v = int16/32768` | 窗 25 ms / 步 10 ms |
| 参考电平 `refDb` | 所有 "有声帧"（> `voicedThrDb`）dB 值的**中位数** | > −45 dB |
| 决策窗 (window) | 连续 `winFrames` 个帧取**中位数**作该窗的 dB | 10 帧 / 步 5 帧（≈ 每 50 ms 一个窗） |
| 窗参考 `winRefDb` | 所有决策窗 dB 的**中位数** | — |
| 谷阈 `valleyThrDb` | `winRefDb − valleyMarginDb` | −20 dB |

> 原实现对"谷"的注释写的是 −22 dB，代码里实际是 **−20 dB**；本包按**代码**取值（`valleyMarginDb: 20`），
> 因为它才是产生那批回归数据的那一版。

### 1.2 裁剪：五道闸，全过才裁

| 闸 | 内容 | 不过就怎样 |
| --- | --- | --- |
| ① 静音谷 | 开头 `valleySearchSec`(1.5 s) 内找到**连续 `valleyMinWins`(3) 个**决策窗 ≤ `valleyThrDb`（≈150 ms 真停顿），并向后吞掉所有连续低窗得到 `[gi, gj)` | 判不出"前面那截是吸气还是说话人本来就轻轻地起音" ⇒ 不裁 |
| ② 谷后语音起点 | 谷后第一个 ≥ `winRefDb − voiceRefMarginDb`(8 dB) 的窗，记 `tVoice`（＝`riseTime`）；同时统计谷前峰值 `headPeak` 与谷后 0.3 s 内峰值 `tailPeak` | 找不到语音起点 ⇒ 不裁 |
| ③ 护栏（三条） | (a) 开头 `digitalSilSearchSec`(0.5 s) 内出现 ≤ `digitalSilDb`(−90 dB) 的窗 ⇒ **那截是停顿不是吸气**；(b) 谷前没有可测头窗、或 `headPeak < winRefDb − headFloorDb`(35 dB) ⇒ 本来就没什么可裁；(c) `riseTime < riseMin`(0.30 s) ⇒ 脆起音，正常 | 任一命中 ⇒ 不裁 |
| ④ 宽闸 / 窄通道 | 宽闸：`tailPeak − headPeak ≥ ratioDeltaDb`(8 dB)；窄通道：`δ ≥ narrowDeltaDb`(5 dB) **且** 谷前"峰值口径 rise" ≥ `riseMin`。两者都不满足 ⇒ 谷前是弱起音而不是吸气 | 不裁 |
| ⑤ 裁点与上限 | 裁点 `cutSample = floor((tVoice − cutLeadSec)*sr)`（留 50 ms 余量，免得削掉起音）；必须落在线内，且 `cutSample ≤ 全长 × maxTrimRatio`(30%) | 越界或超上限 ⇒ 宁可不裁 |

谷前"峰值口径 rise"＝从谷前**第一个** > `preDb`(−55 dB) 的窗爬到谷前峰值窗所耗的时间（窗间隔 = `winStepFrames × hop / sr`）。
它是"真吸气（慢慢涨起来的一整段）"与"短弱首词（脆起音）"的分界线：

- **平头**的头窗（各窗一样响）算出的 rise = 0 —— 峰值窗就是第一个窗，不满足 `peakAt > first`；
- 只有真正**单调爬升**的头窗才有 rise > 0。

### 1.3 裁剪后的输出

裁剪会**重写一份规范的 44 字节头**（`RIFF/WAVE/fmt /data`，单声道 16-bit，`byteRate = sr*2`），
原文件里 `fmt ` 之后的多余块（`LIST`、`fact` …）**不会保留**，数据区 = 原数据从 `cutSample` 起的尾巴。

衰减（`attenuateHead`）相反：它只改头窗内的样本，**其余字节（含原头）逐字节不变**。

### 1.4 衰减与自适应窗

- 头窗长度 `ms`（缺省 300 ms），前 `n − fade` 个样本按 `gainDb`(缺省 −15 dB) 衰减，
  最后 `fadeMs`(40 ms) 线性淡出到 1（避免咔哒）；出窗之后一个字节都不动。
- 自适应窗：`thr = rmsDb(0, 全长) − relDb`(6 dB)；从 0 起每 `stepMs`(20 ms) 扫，
  第一次**连续两帧**都 > `thr` 就返回该位置；`scanMs`(500 ms) 内扫不到 ⇒ 返回 `maxMs`。
  返回值恒为 `max(max(minMs, min(maxMs, t)), minMs)` 形式的结果，即**被夹在 `[minMs, maxMs]`**。
- `processHead` 里若自适应窗 ≤ `minMs`(40 ms)，说明**开头就是语音起音**：跳过衰减，不压。

### 1.5 `processHead` 的顺序（与原实现一致）

```
① trimLeadingAspiration(输入)
② adaptiveHeadWindowMs(①的输出)          ← 注意：窗口是在「已裁过的音频」上算的
③ attenuateHead(①的输出, ②的窗口)         ← 窗口 ≤ minMs 时跳过
```

---

## 2. API

| 导出 | 签名 | 返回 |
| --- | --- | --- |
| `parseWav` | `parseWav(buffer)` | `{ sampleRate, channels, bitsPerSample, formatTag, byteRate, blockAlign, dataOffset, dataLength, byteLength, totalSamples, totalFrames, durationSec, chunks }` |
| `headMetrics` | `headMetrics(buffer, opts?)` | 诊断对象（字段见 §3）。输入不受支持时**抛错** |
| `trimLeadingAspiration` | `trimLeadingAspiration(buffer, opts?)` | `{ buffer, diag }`；`diag.trimmed` 表示是否裁了 |
| `attenuateHead` | `attenuateHead(buffer, opts?)` | `{ buffer, diag }`；`diag.ok === false` 表示输入不是 16-bit PCM |
| `adaptiveHeadWindowMs` | `adaptiveHeadWindowMs(buffer, opts?)` | `number`（毫秒）；无法分析时返回 `maxMs` |
| `processHead` | `processHead(buffer, opts?)` | `{ buffer, diag: { changed, trim, head } }` |
| `DEFAULTS` | 冻结对象 | 全部缺省值（见 §4） |
| `WavFormatError` | `Error` 子类 | `err.code` ∈ `not-riff-wave` / `missing-fmt-data` / `malformed` / `unsupported-format` |

`opts` 是**扁平对象**，只写要改的键；`undefined` 的键被忽略（不会覆盖缺省值）。
所有函数都拒绝非 Buffer/Uint8Array/ArrayBuffer 的输入（`TypeError`）。

### 2.1 `trimLeadingAspiration` 的 `diag`

| 字段 | 含义 |
| --- | --- |
| `trimmed` / `changed` | 是否真的裁了（两者相同） |
| `code` | 结局代号：`trimmed`、`no-valley`、`crisp-onset`、`weak-onset`、`digital-silence`、`no-measurable-head`、`over-cap`、`cut-out-of-range`、`no-voice-onset`、`audio-too-short`、`too-few-frames`、`too-few-windows`、`no-voiced-frames`、`unsupported-format`、`not-riff-wave`、`missing-fmt-data`、`malformed` |
| `reason` | 人话解释（英文，中性表述） |
| `riseTime` | `tVoice`（秒）。**只有原实现也给出它的那几种结局才有这个键** |
| `narrow` | 是否走的窄通道（仅在 `trimmed` 时存在） |
| `cut` | 裁掉多少秒，**四舍五入到 2 位**（与原实现同款，便于对拍） |
| `oldSeconds` / `newSeconds` | 裁前/裁后总秒数（2 位，同原实现） |
| `cutSample` | **精确**裁掉的样本数（要按样本对齐就用它，不要用 `cut`） |
| `cutRatio` | `cutSample / 总样本数` |
| `newTotalSamples` | 裁后总样本数 |
| `deltaDb` / `headRiseSec` / `headPeakDb` / `tailPeakDb` | 判据用的中间量（未走到该步时为 `null`） |
| `valleyStartSec` / `valleyEndSec` | 谷的起止秒（未找到谷时为 `null`） |
| `headDigitalSilence` | 是否命中数字静音护栏 |
| `sampleRate` / `durationSec` / `strict` | 回声 |

### 2.2 `attenuateHead` 的 `diag`

`{ ok, changed, code?, reason?, ms, gainDb, fadeMs, sampleRate, channels, samplesPerChannel, fadeSamples, gain }`
（`ms` / `gainDb` 回显传入值，`samplesPerChannel` 是实际处理到的样本数 —— 会被文件长度夹住。）

### 2.3 `processHead` 的 `diag`

`{ changed, trim, head }`：`trim` 就是 §2.1 那个对象；`head` 是
`{ ok, changed, skipped, adaptiveWindowMs, ms, gainDb, fadeMs, sampleRate, channels, samplesPerChannel, fadeSamples, gain, code?, reason? }`，
被跳过时 `skipped: true` 且带 `code: 'onset-at-head'`。

---

## 3. `headMetrics` 字段

| 字段 | 含义 |
| --- | --- |
| `ok` | 格式是否被接受（`false` 时 `headMetrics` 直接抛错，所以拿到对象时恒为 `true`） |
| `code` / `reason` | 结局与解释；判据没过时 `trimmed: false` |
| `trimmed` | 结论：是否建议裁 |
| `sampleRate` / `channels` / `bitsPerSample` / `dataOffset` / `dataLength` | 布局 |
| `totalSamples` / `durationSec` | 样本数、秒数 |
| `frameWinSamples` / `frameHopSamples` / `frameCount` | 帧参数与实际帧数 |
| `framesDb` | `Float64Array`，逐帧 dB（原始曲线） |
| `voicedFrameCount` / `refDb` | 有声帧数、有声帧中位数（dB） |
| `winFrames` / `winStepFrames` / `winCount` | 决策窗参数与窗数 |
| `windows` | `[{ tSec, db }]`，逐决策窗的 dB 曲线 |
| `winRefDb` | 决策窗 dB 中位数 |
| `valleyThrDb` | 谷阈 = `winRefDb − valleyMarginDb` |
| `valleyFound` | 是否找到谷（且谷后还有内容） |
| `valleyStartWinIndex` / `valleyEndWinIndex` | 谷的窗下标 `[gi, gj)` |
| `valleyStartSec` / `valleyEndSec` | 谷的起止秒 |
| `headPeakDb` / `headWinCount` | 谷前峰值 dB、谷前窗数 |
| `tVoiceSec` / `riseTimeSec` | 谷后语音起点（＝该口径的 rise，秒） |
| `tailPeakDb` | 语音起点后 `tailPeakSec` 内的峰值 |
| `deltaDb` | `tailPeakDb − headPeakDb` |
| `headRiseSec` | 谷前"峰值口径 rise"（秒） |
| `widePass` / `narrowPass` | 宽闸 / 窄通道是否放行 |
| `headDigitalSilence` | 是否命中数字静音护栏 |
| `cutSample` / `cutSec` / `cutRatio` | 裁点（样本/秒/比例） |
| `newTotalSamples` / `newDurationSec` | 裁后样本数/秒数 |
| `narrow` | 是否靠窄通道命中 |

---

## 4. 参数缺省值

| 参数 | 缺省 | 作用 |
| --- | --- | --- |
| **裁剪** | | |
| `riseMin` | `0.30` | 谷后语音起点的 rise 阈值（秒） |
| `headFloorDb` | `35` | 谷前峰值至少要 ≥ `winRefDb − 35` |
| `ratioDeltaDb` | `8` | 宽闸：谷后峰 − 谷前峰（dB） |
| `narrowDeltaDb` | `5` | 窄通道：δ 下界（dB） |
| `preDb` | `-55` | 谷前"峰值口径 rise"的起点电平 |
| `voicedThrDb` | `-45` | 有声帧判定 |
| `minVoicedFrames` | `4` | 有声帧数下限 |
| `frameWinSec` / `frameHopSec` | `0.025` / `0.01` | 帧窗/步长（秒） |
| `winFrames` / `winStepFrames` | `10` / `5` | 决策窗帧数/步长 |
| `minWins` | `8` | 决策窗数下限 |
| `valleyMarginDb` | `20` | 谷阈 = 窗中位 − 20 dB |
| `valleyMinWins` | `3` | 连续多少个低窗算谷 |
| `valleySearchSec` | `1.5` | 只在开头这么多秒内找谷 |
| `voiceRefMarginDb` | `8` | 谷后语音起点 = 首个 ≥ 窗中位 − 8 dB 的窗 |
| `tailPeakSec` | `0.3` | 谷后峰值统计时长（秒） |
| `digitalSilDb` / `digitalSilSearchSec` | `-90` / `0.5` | 数字静音护栏阈值/搜索时长 |
| `cutLeadSec` | `0.05` | 裁点前留的余量（秒） |
| `maxTrimRatio` | `0.30` | 裁切量上限（占全长比例） |
| `minDurationDivisor` | `4` | 最短时长 = `sr / 4` |
| **衰减** | | |
| `ms` | `300` | 头窗长度（毫秒） |
| `gainDb` | `-15` | 头窗增益（dB） |
| `fadeMs` | `40` | 末端淡出（毫秒） |
| **自适应窗** | | |
| `maxMs` | `300` | 窗上限、也是扫不到时的回退值 |
| `relDb` | `6` | "电平顶起来"＝比整句 RMS 高这么多 dB |
| `stepMs` | `20` | 扫描步长（毫秒） |
| `scanMs` | `500` | 最远扫到哪（毫秒） |
| `minMs` | `40` | 窗下限；`processHead` 里 ≤ 它的窗会被跳过 |
| **`processHead` 开关与别名** | | |
| `trimAspiration` | `true` | 跑不跑第 ① 步 |
| `headAttenuateEnable` | `true` | 跑不跑第 ②③ 步 |
| `headAttenuateAdaptive` | `true` | 用自适应窗还是写死的 `headAttenuateMs` |
| `trimRiseMin` | — | `riseMin` 的别名（原插件 config 键名） |
| `headAttenuateMs` / `headAttenuateDb` / `headAttenuateRelDb` / `headAttenuateFadeMs` | — | `ms` / `gainDb` / `relDb` / `fadeMs` 的别名；**别名优先** |

> `processHead` 的"头窗上限"按 **`headAttenuateMs` → `ms` → `maxMs` → 300** 的顺序取值（先给谁用谁），
> 同时它也是内部自适应窗的 `maxMs`。`gainDb` 同理：`headAttenuateDb` → `gainDb` → −15。
| `strict` | `false` | `true` 时，不支持的输入直接抛 `WavFormatError` |

---

## 5. 实测数据（来自原实现的回归记录）

下表是**这套判据被定下来时留下的实测数字**（原注释里的实验记录，中性转写）。它们解释了每个阈值的来处。

| # | 观测 | 数值 | 对应的阈值/结论 |
| --- | --- | --- | --- |
| 1 | 配方扫描 | 30 条 × 3 配方 | 判据的取样规模 |
| 2 | 慢升吸气出现率 | 约 1/30 | 稀缺，但扎耳 |
| 3 | 慢升吸气的 rise | ≥ 0.30 s | `riseMin = 0.30` |
| 4 | 其余脆起音的 rise | 0.04–0.19 s | 与 0.30 有干净间隔 |
| 5 | 第一批裁剪命中 | 1/30 | — |
| 6 | 裁剪后的转写 | 与裁剪前逐字一致 | 不丢字 |
| 7 | 某条真实样本的 δ | 7.05 dB（< 8） | 被宽闸整条放行 ⇒ 催生窄通道 |
| 8 | 窄通道 δ 下界 | 5 dB | `narrowDeltaDb = 5` |
| 9 | 短弱首词（はい 系）的 δ | 5.3–6.5 dB | 正落在窄带里，必须另有条件挡 |
| 10 | 短弱首词谷前的 rise | 0.05–0.10 s | 被 `riseMin` 挡住 ⇒ 窄通道安全 |
| 11 | 80 条样本回归：命中 | 2 条（宽闸 1 条 + 窄通道新增 1 条） | 出货判据 |
| 12 | 80 条样本回归：零变化 | 其余 78 条 | — |
| 13 | 撤掉 ≥8 dB 宽闸的后果 | 会多裁 6 条**已验收**件 | 宽闸必须留 |
| 14 | 真吸气占全长的比例 | 约 14% | 30% 上限的来源（超过就判据不可信） |
| 15 | 开头气流的电平 | −47 dB 爬到 −16 dB | 衰减对象 |
| 16 | 开头 300 ms 与整句 RMS 之差 | 低 6–20 dB | 按音量它不算响 ⇒ 纯音量判据治不了 |
| 17 | 这类气流的 δ | 5.5–7.4 dB | < 8 ⇒ 裁剪也治不了 |
| 18 | 衰减档位 | 12–18 dB，取中值 15 dB | `gainDb = -15` |
| 19 | 同源 A/B/C 对照 | 0–300 ms：−18.8 → −30.5 dB（压掉 11.7 dB） | 固定 300 ms 会把入场早的产物压过头 ⇒ 改自适应 |
| 20 | 本包的兼容回归 | **345 个 wav / 345 逐字节一致**（见 §6） | — |
| 21 | 独立复验（2026-09-23，另一次会话 · 现装插件当参考实现） | **55 个 wav / 55 逐字节一致**（含触发裁剪那条） | — |

---

## 6. 兼容性回归（逐字节对拍）

`scripts/compare-with-original.mjs` 会把**参考实现**和**本包**跑在同一批 wav 上，逐字节比较输出：

```
node scripts/compare-with-original.mjs <语料目录> [<更多语料目录> ...]
```

- 参考实现缺省从当前用户的 `~/.dsh/profiles/*/local-plugins/dsh-voice-local/lib/index.js` 自动探测
  （`~` 由 `os.homedir()` 在运行时求出，脚本里没有写死任何人的路径）；
  也可以用 `--original <file>` 或环境变量 `WHT_ORIGINAL_PLUGIN` 指定。
- 若那个模块**没有导出**需要的三个函数（或根本 import 不了），脚本会自动退到
  **源码抽取**模式：把顶层 `function name(...) {...}`（含私有辅助函数）连带花括号一起抠出来，
  用 `new Function(...)` 求值，照样拿到原实现。两条路径都实测跑通（见下）。
- 由于原实现是"给路径、就地改写文件"，脚本先把每个 wav 复制进系统临时目录再跑，**语料只读**。
- 步骤：`trimLeadingAspiration` → `adaptiveHeadWindowMs` → `attenuateHead`（窗口 ≤ `minMs` 则跳过第 3 步）。
- 同时比对 `diag`（`trimmed / riseTime / narrow / cut / oldSeconds / newSeconds`、`ok / ms / gainDb`、
  `adaptiveWindowMs`、`skipped`）。
- 退出码：全一致 `0`；有差异 `1`（可直接当 CI 门禁）；**`2` ＝ 本次对比无效**（某个语料目录读不到，
  或压根没比到任何 wav）—— 「一次没发生的对比」**绝不许当通过**报出来。
  这条是 2026-09-23 独立复验时补的：原先目录读不到只打一行告警、仍然 `exit 0`，是**假绿**。

本机实测（三个语料目录，递归共 345 个 wav）：

```
wav-head-trim · compare-with-original
original implementation : module exports
steps                   : trimLeadingAspiration -> adaptiveHeadWindowMs -> attenuateHead
parameters              : riseMin=0.3 capMs=300 gainDb=-15 relDb=6 minMs=40
directories             : 3 (recursive)
files scanned           : 345
original trimmed        : 4 file(s)
original attenuated     : 316 file(s)  (window <= minMs, so step 3 skipped: 29)

结果：345 个文件 / 完全一致 345 / 不一致 0
```

把参考实现换成"删掉 `export` 关键字"的副本后（强制走源码抽取兜底），结果同样
`345 个文件 / 完全一致 345 / 不一致 0`，`original implementation : source extraction fallback (functions not exported)`。

**独立复验（2026-09-23，另一次会话 · 换语料 ＋ 换参考实现来源）**：拿**现装**插件模块
`<profile>/local-plugins/dsh-voice-local/lib/index.js` 当参考实现，跑 2 个语料目录（递归 55 个 wav，
含触发裁剪的那条）：

```
files scanned           : 55
original trimmed        : 1 file(s)
original attenuated     : 54 file(s)  (window <= minMs, so step 3 skipped: 1)

结果：55 个文件 / 完全一致 55 / 不一致 0          (exit 0)
```

另跑一次**故意给错路径**：修前 `exit 0`（假绿），修后 `exit 2` ＋
`inconclusive: no WAV file was compared — refusing to report a pass`。

---

## 7. 限制

- **只支持 16-bit PCM 的 RIFF/WAVE**。8-bit、24-bit、32-bit、IEEE float、ADPCM、非 RIFF 容器
  （RF64 / WAVE64 / AIFF）一律不受支持：`parseWav` / `headMetrics` 抛 `WavFormatError`，
  处理函数缺省情况下**原样返回输入**并在 `diag.code` / `diag.reason` 里说明（`strict: true` 时抛错）。
- 裁剪要求**单声道**（与原实现一致，输出头是写死的单声道 16-bit）；衰减支持 16-bit 多声道。
- 它**不是降噪器**，也不做任何频谱处理：不压底噪、不去混响、不修爆音，只在**头部**做裁剪和增益。
- 判据是**统计式**的：它靠"开头有没有静音谷 + 谷后电平是否明显抬起来"来判断，
  不识别语音内容。停顿位置异常的素材（比如一句话中间先静后响）可能被误判 —— 30% 上限就是为此兜底。
- 自适应窗只保证"**不会比固定窗更狠**"，不保证"一定压得准"。
- 输出头是规范 44 字节：多余块（`LIST`/`fact`/元数据）在**裁剪**后不保留；用 `attenuateHead` 则原样保留。

---

## 8. 开发

```bash
node --test                                # 34 个测试用例
node scripts/compare-with-original.mjs <语料目录> ...
```

测试数据全部**在代码里合成**（正弦波 + 静音 + 慢升包络 → 16-bit PCM WAV Buffer），
仓库里没有任何二进制样本文件。

## License

MIT —— 见 `LICENSE`。`Copyright (c) 2026 an94-code`。
