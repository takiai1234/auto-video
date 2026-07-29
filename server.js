'use strict';
require('dotenv').config();

const express      = require('express');
const multer       = require('multer');
const { spawn }    = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const path         = require('path');
const fs           = require('fs');
const { randomUUID } = require('crypto');
const Anthropic    = require('@anthropic-ai/sdk');

const _ffmpegLocal = path.join(__dirname, 'bin', 'ffmpeg');
const FFMPEG = fs.existsSync(_ffmpegLocal) ? _ffmpegLocal : require('ffmpeg-static');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const batchJobs = new Map();

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
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ─── Auto-wrap text ───────────────────────────────────────────────────────────
function autoWrap(text, maxChars = 26) {
  const lines = [];
  text.split('\n').forEach(rawLine => {
    if (!rawLine.trim()) return;
    const words = rawLine.trim().split(' ');
    let cur = '';
    words.forEach(w => {
      if ((cur ? cur + ' ' + w : w).length > maxChars && cur.length > 0) {
        lines.push(cur); cur = w;
      } else {
        cur = cur ? cur + ' ' + w : w;
      }
    });
    if (cur) lines.push(cur);
  });
  return lines.filter(Boolean);
}

// ─── #RRGGBB → ASS &H00BBGGRR ────────────────────────────────────────────────
function hexToASS(hex) {
  const c = hex.replace('#', '');
  return `&H00${c.slice(4,6).toUpperCase()}${c.slice(2,4).toUpperCase()}${c.slice(0,2).toUpperCase()}`;
}

// ─── Generate ASS subtitle file ───────────────────────────────────────────────
function generateASS(config, assPath) {
  const { titleLines, subtitle, textYPercent, titleFontSize, subFontSize, titleColor, subColor } = config;
  const titleASS = hexToASS(titleColor || '#ffffff');
  const subASS   = hexToASS(subColor   || '#ffff00');
  const lineH    = Math.round(titleFontSize * 1.38);
  const subLineH = Math.round(subFontSize   * 1.38);
  const totalH   = titleLines.length * lineH + (subtitle ? subLineH + 6 : 0);
  const blockTop = Math.round(1920 * textYPercent / 100 - totalH / 2);
  const esc = t => t.replace(/\\/g, '∖').replace(/\{/g, '｛').replace(/\}/g, '｝');
  const dialogues = [];
  titleLines.forEach((line, i) => {
    const lineBottom = blockTop + (i + 1) * lineH;
    dialogues.push(`Dialogue: 0,0:00:00.00,2:00:00.00,T,,0,0,${Math.max(0, 1920 - lineBottom)},,${esc(line)}`);
  });
  if (subtitle) {
    const rawSub   = subtitle.startsWith('(') ? subtitle : `(${subtitle})`;
    const subBottom = blockTop + titleLines.length * lineH + 6 + subLineH;
    dialogues.push(`Dialogue: 0,0:00:00.00,2:00:00.00,S,,0,0,${Math.max(0, 1920 - subBottom)},,${esc(rawSub)}`);
  }
  fs.writeFileSync(assPath, [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 1920', 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: T,Noto Sans,${titleFontSize},${titleASS},${titleASS},&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,3,2,0,0,0,1`,
    `Style: S,Noto Sans,${subFontSize},${subASS},${subASS},&H00000000,&H00000000,1,1,0,0,100,100,0,0,1,1,2,2,0,0,0,1`,
    '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...dialogues,
  ].join('\n'), 'utf8');
}

// ─── Get video duration ───────────────────────────────────────────────────────
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

// ─── Build filter_complex ─────────────────────────────────────────────────────
function buildFilterComplex(assPath, config, numVideos, hasMusic, durations) {
  const { overlayOpacity, musicVolume, keepOrigAudio, origVolume, transitionEffect, transitionDuration } = config;
  const bf = (1.0 - overlayOpacity * 0.75).toFixed(3);
  const n = numVideos;
  const musicIdx = n;
  const T = parseFloat(transitionDuration) || 0.5;
  const useXfade = transitionEffect && transitionEffect !== 'none'
    && n > 1 && Array.isArray(durations)
    && durations.every(d => typeof d === 'number' && d > T);
  const escapedPath = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const fontsDir = path.join(__dirname, 'fonts').replace(/\\/g, '/').replace(/:/g, '\\:');
  const parts = [];

  for (let i = 0; i < n; i++) {
    parts.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p[s${i}]`);
  }

  let videoOut;
  if (n === 1) {
    videoOut = 's0';
  } else if (useXfade) {
    let cumDur = durations[0];
    for (let i = 0; i < n - 1; i++) {
      const inA = i === 0 ? 's0' : `xf${i - 1}`;
      const offset = Math.max(0, cumDur - T).toFixed(3);
      parts.push(`[${inA}][s${i+1}]xfade=transition=${transitionEffect}:duration=${T}:offset=${offset}[xf${i}]`);
      cumDur = cumDur + durations[i + 1] - T;
    }
    videoOut = `xf${n - 2}`;
  } else {
    parts.push(`${Array.from({length:n},(_,i)=>`[s${i}]`).join('')}concat=n=${n}:v=1:a=0[concatv]`);
    videoOut = 'concatv';
  }

  parts.push(`[${videoOut}]colorchannelmixer=rr=${bf}:gg=${bf}:bb=${bf}[dark]`);
  parts.push(`[dark]format=rgba,subtitles='${escapedPath}':fontsdir='${fontsDir}',format=yuv420p[v]`);

  if (keepOrigAudio) {
    let audioOut;
    if (n === 1) {
      audioOut = '0:a';
    } else if (useXfade) {
      for (let i = 0; i < n - 1; i++) {
        const inA = i === 0 ? '0:a' : `af${i - 1}`;
        parts.push(`[${inA}][${i+1}:a]acrossfade=d=${T}[af${i}]`);
      }
      audioOut = `af${n - 2}`;
    } else {
      parts.push(`${Array.from({length:n},(_,i)=>`[${i}:a]`).join('')}concat=n=${n}:v=0:a=1[concata]`);
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

  return { fc: parts.join(';'), hasAudioOut: keepOrigAudio || hasMusic };
}

// ─── Build ffmpeg args ────────────────────────────────────────────────────────
function buildFFmpegArgs(videoPaths, musicPath, assPath, config, outputPath, durations) {
  const hasMusic = !!musicPath;
  const { fc, hasAudioOut } = buildFilterComplex(assPath, config, videoPaths.length, hasMusic, durations);
  const args = [];
  for (const vp of videoPaths) args.push('-i', vp);
  if (hasMusic) args.push('-stream_loop', '-1', '-i', musicPath);
  args.push('-filter_complex', fc, '-map', '[v]');
  if (hasAudioOut) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-shortest', '-movflags', '+faststart', '-y', outputPath);
  return args;
}

// ─── Google Drive ─────────────────────────────────────────────────────────────
async function listDriveVideos(folderId, apiKey) {
  const q = encodeURIComponent(`'${folderId}' in parents and mimeType contains 'video/' and trashed = false`);
  const fields = encodeURIComponent('files(id,name,mimeType,size)');
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&key=${encodeURIComponent(apiKey)}&fields=${fields}&pageSize=100`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.files || [];
}

async function downloadDriveFile(fileId, apiKey, destPath) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Drive download error ${res.status}: ${text.slice(0, 150)}`);
  }
  const writer = fs.createWriteStream(destPath);
  await pipeline(Readable.fromWeb(res.body), writer);
}

// ─── AI Content Generation ────────────────────────────────────────────────────
async function generateContentVariations(baseTitle, baseSubtitle, count) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Chưa cấu hình ANTHROPIC_API_KEY trong file .env trên server');
  }
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `Tạo ${count} biến thể nội dung video ngắn (TikTok/Reels/Shorts). Giữ nguyên chủ đề và phong cách, đa dạng cách diễn đạt. Chỉ trả về JSON array, không thêm gì khác:
[{"title":"...","subtitle":"..."}]

Tiêu đề gốc: ${baseTitle}
Phụ đề gốc: ${baseSubtitle || '(không có)'}`
    }]
  });
  const text = msg.content[0].text.trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('AI không trả về JSON hợp lệ');
  const arr = JSON.parse(match[0]);
  if (!Array.isArray(arr)) throw new Error('Kết quả không phải array');
  return arr.slice(0, count);
}

// ─── Batch Processing ─────────────────────────────────────────────────────────
async function processBatch(batchId) {
  const batch = batchJobs.get(batchId);
  if (!batch) return;

  for (let i = 0; i < batch.items.length; i++) {
    const item = batch.items[i];
    item.status = 'processing';

    const videoPath  = path.join(UPLOAD_DIR, `${randomUUID()}.mp4`);
    const assPath    = path.join(UPLOAD_DIR, `${randomUUID()}.ass`);
    const outputPath = path.join(OUTPUT_DIR,  `${batchId}_${i}.mp4`);

    try {
      const file = batch.driveFiles[Math.floor(Math.random() * batch.driveFiles.length)];
      console.log(`[batch ${batchId.slice(0,6)}] ${i+1}/${batch.items.length} — downloading: ${file.name}`);
      await downloadDriveFile(file.id, batch.driveApiKey, videoPath);

      const titleLines = autoWrap(item.title, batch.config.maxChars || 26);
      if (!titleLines.length) throw new Error('Tiêu đề trống');

      generateASS({ ...batch.config, titleLines, subtitle: item.subtitle || '' }, assPath);

      const args = buildFFmpegArgs([videoPath], batch.musicPath, assPath, batch.config, outputPath, null);

      await new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => {
          fs.unlink(videoPath, () => {});
          fs.unlink(assPath,   () => {});
          if (code === 0 && fs.existsSync(outputPath)) resolve();
          else reject(new Error(stderr.slice(-600)));
        });
      });

      item.status     = 'done';
      item.file       = `${batchId}_${i}.mp4`;
      item.sizeMB     = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
      item.sourceName = file.name;
      console.log(`[batch ${batchId.slice(0,6)}] ${i+1} done (${item.sizeMB} MB)`);
    } catch (err) {
      item.status = 'error';
      item.error  = err.message.slice(0, 400);
      console.error(`[batch ${batchId.slice(0,6)}] ${i+1} error:`, err.message.slice(0, 200));
      fs.unlink(videoPath, () => {});
      fs.unlink(assPath,   () => {});
    }
  }

  if (batch.musicPath) fs.unlink(batch.musicPath, () => {});

  const doneCount  = batch.items.filter(x => x.status === 'done').length;
  const errorCount = batch.items.filter(x => x.status === 'error').length;
  batch.status = errorCount === batch.items.length ? 'error'
               : doneCount  === batch.items.length ? 'done'
               : 'partial';
  console.log(`[batch ${batchId.slice(0,6)}] finished: ${doneCount} done, ${errorCount} errors`);
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// List Google Drive videos
app.get('/api/drive/list', async (req, res) => {
  const { folderId, apiKey } = req.query;
  if (!folderId || !apiKey) return res.status(400).json({ error: 'Thiếu folderId hoặc apiKey' });
  try {
    const files = await listDriveVideos(folderId, apiKey);
    res.json({ count: files.length, files });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Generate AI content variations
app.post('/api/content/generate', async (req, res) => {
  const { baseTitle, baseSubtitle, count } = req.body;
  if (!baseTitle?.trim()) return res.status(400).json({ error: 'Thiếu tiêu đề gốc' });
  const n = Math.min(Math.max(parseInt(count) || 1, 1), 20);
  try {
    const variations = await generateContentVariations(baseTitle.trim(), (baseSubtitle || '').trim(), n);
    res.json({ variations });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start batch job
app.post('/api/batch', upload.single('music'), async (req, res) => {
  const { folderId, apiKey, items: itemsJSON } = req.body;

  if (!folderId?.trim() || !apiKey?.trim()) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Thiếu Google Drive Folder ID hoặc API Key' });
  }

  let items;
  try {
    items = JSON.parse(itemsJSON || '[]');
    if (!Array.isArray(items) || !items.length) throw new Error();
  } catch {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Danh sách nội dung không hợp lệ' });
  }

  const validItems = items.filter(it => it?.title?.trim());
  if (!validItems.length) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Cần có ít nhất 1 video với tiêu đề' });
  }

  let driveFiles;
  try {
    driveFiles = await listDriveVideos(folderId.trim(), apiKey.trim());
    if (!driveFiles.length) throw new Error('Không tìm thấy video nào trong folder');
  } catch (e) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Lỗi Drive: ' + e.message });
  }

  const body = req.body;
  const config = {
    overlayOpacity:     parseFloat(body.overlayOpacity   ?? 0.45),
    musicVolume:        parseFloat(body.musicVolume       ?? 0.65),
    keepOrigAudio:      body.keepOrigAudio === 'true',
    origVolume:         parseFloat(body.origVolume        ?? 0.15),
    textYPercent:       parseFloat(body.textY             ?? 52),
    titleFontSize:      parseInt(body.titleFontSize        ?? 52),
    subFontSize:        parseInt(body.subFontSize          ?? 38),
    titleColor:         body.titleColor  || '#ffffff',
    subColor:           body.subColor    || '#ffff00',
    transitionEffect:   'none',
    transitionDuration: 0,
    maxChars:           parseInt(body.maxChars            ?? 26),
  };

  const batchId = randomUUID();
  batchJobs.set(batchId, {
    status:      'processing',
    driveFiles,
    driveApiKey: apiKey.trim(),
    musicPath:   req.file?.path || null,
    config,
    items: validItems.map(it => ({
      title:    it.title.trim(),
      subtitle: it.subtitle?.trim() || '',
      status:   'queued',
    })),
    createdAt: Date.now(),
  });

  res.json({ batchId, total: validItems.length, driveVideoCount: driveFiles.length });

  processBatch(batchId).catch(err => {
    console.error('[processBatch unhandled]', err.message);
    const b = batchJobs.get(batchId);
    if (b && b.status === 'processing') b.status = 'error';
  });
});

// Batch status via SSE
app.get('/api/batch/:batchId/status', (req, res) => {
  const batch = batchJobs.get(req.params.batchId);
  if (!batch) return res.status(404).json({ error: 'Không tìm thấy batch' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const payload = () => {
    const b = batchJobs.get(req.params.batchId);
    if (!b) return null;
    return {
      status: b.status,
      total:  b.items.length,
      done:   b.items.filter(x => x.status === 'done').length,
      items:  b.items.map(({ title, subtitle, status, file, sizeMB, error, sourceName }) =>
                ({ title, subtitle, status, file, sizeMB, error, sourceName })),
    };
  };

  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);
  const d = payload();
  if (d) send(d);
  if (!d || d.status !== 'processing') return res.end();

  const iv = setInterval(() => {
    const d = payload();
    if (!d) { clearInterval(iv); return res.end(); }
    send(d);
    if (d.status !== 'processing') { clearInterval(iv); res.end(); }
  }, 800);
  req.on('close', () => clearInterval(iv));
});

// Download output video
app.get('/api/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const fp = path.join(OUTPUT_DIR, filename);
  if (!fs.existsSync(fp)) return res.status(404).send('Không tìm thấy');
  const cleanName = filename.replace(/^[a-f0-9-]+_(\d+)\.mp4$/, (_, n) =>
    `video_${String(parseInt(n) + 1).padStart(2, '0')}.mp4`);
  res.download(fp, cleanName);
});

// Preview video (range-supported)
app.get('/api/preview/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const fp = path.join(OUTPUT_DIR, filename);
  if (!fs.existsSync(fp)) return res.status(404).send('Không tìm thấy');
  const stat  = fs.statSync(fp);
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10);
    const end   = e ? parseInt(e, 10) : stat.size - 1;
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

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎬 Auto Video Creator v3.0 → http://localhost:${PORT}`);
  console.log(`   FFmpeg: ${FFMPEG}`);
  console.log(`   Anthropic API: ${process.env.ANTHROPIC_API_KEY ? '✓ configured' : '✗ ANTHROPIC_API_KEY not set'}\n`);
});
