'use strict';

const express = require('express');
const multer  = require('multer');
const { spawn } = require('child_process');
const path    = require('path');
const fs      = require('fs');
const { randomUUID } = require('crypto');

// Ưu tiên binary local (bin/ffmpeg) nếu có, fallback về ffmpeg-static
const _ffmpegLocal = path.join(__dirname, 'bin', 'ffmpeg');
const FFMPEG = fs.existsSync(_ffmpegLocal) ? _ffmpegLocal : require('ffmpeg-static');

// ─── Directories ──────────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── Job store ────────────────────────────────────────────────────────────────
const jobs = new Map();

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, randomUUID() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 2048 * 1024 * 1024 } });

// ─── Auto-wrap helper ─────────────────────────────────────────────────────────
function autoWrap(text, maxChars = 26) {
  const lines = [];
  text.split('\n').forEach(rawLine => {
    if (!rawLine.trim()) return;
    const words = rawLine.trim().split(' ');
    let cur = '';
    words.forEach(w => {
      if ((cur ? cur + ' ' + w : w).length > maxChars && cur.length > 0) {
        lines.push(cur);
        cur = w;
      } else {
        cur = cur ? cur + ' ' + w : w;
      }
    });
    if (cur) lines.push(cur);
  });
  return lines.filter(Boolean);
}

// ─── Convert #RRGGBB → ASS &H00BBGGRR ────────────────────────────────────────
function hexToASS(hex) {
  const c = hex.replace('#', '');
  const r = c.slice(0, 2).toUpperCase();
  const g = c.slice(2, 4).toUpperCase();
  const b = c.slice(4, 6).toUpperCase();
  return `&H00${b}${g}${r}`;
}

// ─── Generate ASS subtitle file ───────────────────────────────────────────────
// ASS color format: &HAABBGGRR (Alpha Blue Green Red)
// White=&H00FFFFFF  Yellow=&H0000FFFF  Black=&H00000000
//
// Strategy: Alignment=2 (bottom-center) + per-line MarginV.
// NO \pos or \an override tags → avoids libass double-render bugs.
// MarginV in Dialogue = distance from the BOTTOM of the screen to the
// BOTTOM EDGE of that line's text.
function generateASS(config, assPath) {
  const { titleLines, subtitle, textYPercent, titleFontSize, subFontSize, titleColor, subColor } = config;
  const titleASS = hexToASS(titleColor || '#ffffff');
  const subASS   = hexToASS(subColor   || '#ffff00');

  // Empirical line height for NotoSans Bold: fontSize * 1.38 px
  const lineH    = Math.round(titleFontSize * 1.38);
  const subLineH = Math.round(subFontSize   * 1.38);
  const totalH   = titleLines.length * lineH + (subtitle ? subLineH + 6 : 0);

  // Top Y of the entire text block (center at textYPercent% of 1920)
  const blockTop = Math.round(1920 * textYPercent / 100 - totalH / 2);

  // Escape text content (no curly braces, no backslashes)
  const esc = t => t.replace(/\\/g, '∖').replace(/\{/g, '｛').replace(/\}/g, '｝');

  // Dialogue: bottom-center alignment (2). MarginV overrides per-line from Dialogue field.
  // ASS Dialogue format:
  //   Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
  const dialogues = [];

  titleLines.forEach((line, i) => {
    const lineBottom = blockTop + (i + 1) * lineH;
    const marginV    = Math.max(0, 1920 - lineBottom);
    dialogues.push(`Dialogue: 0,0:00:00.00,2:00:00.00,T,,0,0,${marginV},,${esc(line)}`);
  });

  if (subtitle) {
    const rawSub   = subtitle.startsWith('(') ? subtitle : `(${subtitle})`;
    const subBottom = blockTop + titleLines.length * lineH + 6 + subLineH;
    const marginV   = Math.max(0, 1920 - subBottom);
    dialogues.push(`Dialogue: 0,0:00:00.00,2:00:00.00,S,,0,0,${marginV},,${esc(rawSub)}`);
  }

  const content = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    // Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,
    //         Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle,
    //         BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Alignment=2 = bottom-center; MarginV per-line overridden in each Dialogue
    `Style: T,Noto Sans,${titleFontSize},${titleASS},${titleASS},&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,3,2,0,0,0,1`,
    `Style: S,Noto Sans,${subFontSize},${subASS},${subASS},&H00000000,&H00000000,1,1,0,0,100,100,0,0,1,1,2,2,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...dialogues,
  ].join('\n');

  fs.writeFileSync(assPath, content, 'utf8');
}

// ─── Get video duration via ffmpeg -i (parse stderr) ─────────────────────────
function getVideoDuration(videoPath) {
  return new Promise(resolve => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-i', videoPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      resolve(m ? parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]) : null);
    });
  });
}

// ─── Build ffmpeg filter_complex ──────────────────────────────────────────────
// durations: number[] | null — required when transitionEffect is not 'none'
function buildFilterComplex(assPath, config, numVideos, hasMusic, durations) {
  const { overlayOpacity, musicVolume, keepOrigAudio, origVolume, transitionEffect, transitionDuration } = config;
  const bf = (1.0 - overlayOpacity * 0.75).toFixed(3);
  const n = numVideos;
  const musicIdx = n;
  const T = parseFloat(transitionDuration) || 0.5;

  // xfade requires: ≥2 clips, a known effect, valid durations each > T
  const useXfade = transitionEffect && transitionEffect !== 'none'
    && n > 1
    && Array.isArray(durations)
    && durations.every(d => typeof d === 'number' && d > T);

  const escapedPath = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const fontsDir = path.join(__dirname, 'fonts').replace(/\\/g, '/').replace(/:/g, '\\:');
  const parts = [];

  // Scale/crop + normalize fps/timebase/pixfmt for xfade compatibility
  for (let i = 0; i < n; i++) {
    parts.push(
      `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p[s${i}]`
    );
  }

  // Join video streams → videoOut label
  let videoOut;
  if (n === 1) {
    videoOut = 's0';
  } else if (useXfade) {
    // Chain xfade: offset = cumulative duration - T for each transition
    let cumDur = durations[0];
    for (let i = 0; i < n - 1; i++) {
      const inA   = i === 0 ? 's0' : `xf${i - 1}`;
      const inB   = `s${i + 1}`;
      const out   = `xf${i}`;
      const offset = Math.max(0, cumDur - T).toFixed(3);
      parts.push(`[${inA}][${inB}]xfade=transition=${transitionEffect}:duration=${T}:offset=${offset}[${out}]`);
      cumDur = cumDur + durations[i + 1] - T;
    }
    videoOut = `xf${n - 2}`;
  } else {
    const vIn = Array.from({ length: n }, (_, i) => `[s${i}]`).join('');
    parts.push(`${vIn}concat=n=${n}:v=1:a=0[concatv]`);
    videoOut = 'concatv';
  }

  parts.push(`[${videoOut}]colorchannelmixer=rr=${bf}:gg=${bf}:bb=${bf}[dark]`);
  parts.push(`[dark]format=rgba,subtitles='${escapedPath}':fontsdir='${fontsDir}',format=yuv420p[v]`);

  // Audio routing — build audioOut label then wire to music
  if (keepOrigAudio) {
    let audioOut;
    if (n === 1) {
      audioOut = '0:a';
    } else if (useXfade) {
      // Chain acrossfade to match video xfade timing
      for (let i = 0; i < n - 1; i++) {
        const inA = i === 0 ? '0:a' : `af${i - 1}`;
        parts.push(`[${inA}][${i + 1}:a]acrossfade=d=${T}[af${i}]`);
      }
      audioOut = `af${n - 2}`;
    } else {
      const aIn = Array.from({ length: n }, (_, i) => `[${i}:a]`).join('');
      parts.push(`${aIn}concat=n=${n}:v=0:a=1[concata]`);
      audioOut = 'concata';
    }

    if (hasMusic) {
      parts.push(`[${audioOut}]volume=${origVolume}[oa]`);
      parts.push(`[${musicIdx}:a]volume=${musicVolume}[ma]`);
      parts.push('[oa][ma]amix=inputs=2:duration=first:dropout_transition=2[a]');
    } else {
      parts.push(`[${audioOut}]volume=${origVolume}[a]`);
    }
  } else if (hasMusic) {
    parts.push(`[${musicIdx}:a]volume=${musicVolume}[a]`);
  }

  const hasAudioOut = keepOrigAudio || hasMusic;
  return { fc: parts.join(';'), hasAudioOut };
}

// ─── Build ffmpeg args array ──────────────────────────────────────────────────
function buildFFmpegArgs(videoPaths, musicPath, assPath, config, outputPath, durations) {
  const hasMusic = !!musicPath;
  const { fc, hasAudioOut } = buildFilterComplex(assPath, config, videoPaths.length, hasMusic, durations);

  const args = [];
  for (const vp of videoPaths) args.push('-i', vp);
  if (hasMusic) args.push('-stream_loop', '-1', '-i', musicPath);

  args.push('-filter_complex', fc, '-map', '[v]');

  if (hasAudioOut) {
    args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '192k');
  } else {
    args.push('-an');
  }

  args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-shortest', '-movflags', '+faststart', '-y', outputPath);

  return args;
}

// ─── POST /process ────────────────────────────────────────────────────────────
app.post('/process',
  upload.fields([{ name: 'video', maxCount: 20 }, { name: 'music', maxCount: 1 }]),
  async (req, res) => {
    const videoFiles = req.files?.['video'];
    const musicFile  = req.files?.['music']?.[0];

    if (!videoFiles?.length) return res.status(400).json({ error: 'Thiếu file video' });

    const body = req.body;
    const rawTitle  = (body.titleText || '').trim();
    const doAutoWrap = body.autoWrap !== 'false';
    const maxChars   = parseInt(body.maxChars || '26');
    const titleLines = doAutoWrap
      ? autoWrap(rawTitle, maxChars)
      : rawTitle.split('\n').map(l => l.trim()).filter(Boolean);

    if (!titleLines.length) {
      videoFiles.forEach(f => fs.unlink(f.path, () => {}));
      if (musicFile) fs.unlink(musicFile.path, () => {});
      return res.status(400).json({ error: 'Cần có nội dung tiêu đề' });
    }

    const config = {
      titleLines,
      subtitle:       (body.subtitleText || '').trim(),
      overlayOpacity: parseFloat(body.overlayOpacity  ?? 0.45),
      musicVolume:    parseFloat(body.musicVolume     ?? 0.65),
      keepOrigAudio:  body.keepOrigAudio === 'true',
      origVolume:     parseFloat(body.origVolume      ?? 0.15),
      textYPercent:   parseFloat(body.textY           ?? 52),
      titleFontSize:  parseInt(body.titleFontSize     ?? 52),
      subFontSize:    parseInt(body.subFontSize       ?? 38),
      titleColor:         body.titleColor        || '#ffffff',
      subColor:           body.subColor          || '#ffff00',
      transitionEffect:   body.transitionEffect  || 'none',
      transitionDuration: parseFloat(body.transitionDuration ?? 0.5),
    };

    const jobId      = randomUUID();
    const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
    const assPath    = path.join(UPLOAD_DIR, `${jobId}.ass`);

    try {
      generateASS(config, assPath);
    } catch (e) {
      return res.status(500).json({ error: 'Không thể tạo subtitle file: ' + e.message });
    }

    jobs.set(jobId, { status: 'processing', progress: 0 });
    res.json({ jobId });

    const videoPaths = videoFiles.map(f => f.path);

    // Get durations when transition effects are needed
    let durations = null;
    if (config.transitionEffect !== 'none' && videoPaths.length > 1) {
      durations = await Promise.all(videoPaths.map(getVideoDuration));
      console.log('[durations]', durations);
    }

    const args = buildFFmpegArgs(videoPaths, musicFile?.path, assPath, config, outputPath, durations);
    console.log('\n[FFmpeg cmd]', FFMPEG, args.map(a => a.includes(' ') ? `"${a}"` : a).join(' '), '\n');

    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrBuf = '';

    proc.stderr.on('data', chunk => {
      stderrBuf += chunk.toString();
      const matches = stderrBuf.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/g);
      if (matches) {
        const last = matches[matches.length - 1].replace('time=', '').split(':');
        const secs = parseFloat(last[0]) * 3600 + parseFloat(last[1]) * 60 + parseFloat(last[2]);
        const j = jobs.get(jobId);
        if (j) j.progress = Math.min(95, Math.round(secs * 10));
      }
    });

    proc.on('close', code => {
      videoFiles.forEach(f => fs.unlink(f.path, () => {}));
      fs.unlink(assPath, () => {});
      if (musicFile) fs.unlink(musicFile.path, () => {});

      if (code === 0 && fs.existsSync(outputPath)) {
        const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
        jobs.set(jobId, { status: 'done', progress: 100, sizeMB });
        console.log(`[✓] Job ${jobId.slice(0,8)} — ${videoFiles.length} video(s), ${sizeMB} MB`);
      } else {
        const errLog = stderrBuf.slice(-1200);
        jobs.set(jobId, { status: 'error', error: 'Xử lý thất bại', log: errLog });
        console.error(`[✗] Job ${jobId.slice(0,8)}:\n`, errLog);
      }
    });
  }
);

// ─── GET /status/:id  (SSE) ───────────────────────────────────────────────────
app.get('/status/:id', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);

  const job = jobs.get(req.params.id);
  if (!job) { send({ error: 'Không tìm thấy job' }); return res.end(); }
  if (job.status !== 'processing') { send(job); return res.end(); }

  send(job);
  const iv = setInterval(() => {
    const j = jobs.get(req.params.id);
    if (!j) { clearInterval(iv); return res.end(); }
    send(j);
    if (j.status !== 'processing') { clearInterval(iv); res.end(); }
  }, 400);
  req.on('close', () => clearInterval(iv));
});

// ─── GET /download/:id ────────────────────────────────────────────────────────
app.get('/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).send('Không tìm thấy');
  res.download(path.join(OUTPUT_DIR, `${req.params.id}.mp4`), 'output-video.mp4');
});

// ─── GET /preview/:id  (range-supported stream) ───────────────────────────────
app.get('/preview/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).send('Không tìm thấy');
  const fp = path.join(OUTPUT_DIR, `${req.params.id}.mp4`);
  if (!fs.existsSync(fp)) return res.status(404).send('File không tồn tại');

  const stat  = fs.statSync(fp);
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end   = endStr ? parseInt(endStr, 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': end - start + 1,
      'Content-Type':   'video/mp4',
    });
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' });
    fs.createReadStream(fp).pipe(res);
  }
});

// ─── GET /jobs (debug) ────────────────────────────────────────────────────────
app.get('/jobs', (req, res) => {
  const list = [];
  jobs.forEach((v, k) => list.push({ id: k, ...v }));
  res.json(list);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎬 Auto Video Creator → http://localhost:${PORT}`);
  console.log(`   FFmpeg: ${FFMPEG}\n`);
});
