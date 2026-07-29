'use strict';
require('dotenv').config();

const express      = require('express');
const multer       = require('multer');
const { spawn }    = require('child_process');
const path         = require('path');
const fs           = require('fs');
const { randomUUID } = require('crypto');
// AI content generation via 9router (no API key needed — uses Claude subscription)

const _ffmpegLocal = path.join(__dirname, 'bin', 'ffmpeg');
const FFMPEG = fs.existsSync(_ffmpegLocal) ? _ffmpegLocal : require('ffmpeg-static');

const UPLOAD_DIR  = path.join(__dirname, 'uploads');
const OUTPUT_DIR  = path.join(__dirname, 'output');
const SOURCES_DIR = path.join(__dirname, 'sources');
const THUMBS_DIR  = path.join(__dirname, 'thumbnails');
[UPLOAD_DIR, OUTPUT_DIR, SOURCES_DIR, THUMBS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const VIDEO_EXT = /\.(mp4|mov|avi|mkv|webm|m4v|wmv|flv)$/i;

const batchJobs = new Map();

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// multer for music uploads (temp)
const musicStorage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, randomUUID() + path.extname(file.originalname)),
});
const uploadMusic = multer({ storage: musicStorage, limits: { fileSize: 200 * 1024 * 1024 } });

// multer for source videos — saved to sources/
const sourceStorage = multer.diskStorage({
  destination: SOURCES_DIR,
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9._-]/g, '_');
    let name = base + ext;
    let i = 1;
    while (fs.existsSync(path.join(SOURCES_DIR, name))) name = `${base}_${i++}${ext}`;
    cb(null, name);
  },
});
const uploadSource = multer({ storage: sourceStorage, limits: { fileSize: 2048 * 1024 * 1024 } });

// ─── Core helpers (unchanged) ─────────────────────────────────────────────────
function autoWrap(text, maxChars = 26) {
  const lines = [];
  text.split('\n').forEach(rawLine => {
    if (!rawLine.trim()) return;
    const words = rawLine.trim().split(' ');
    let cur = '';
    words.forEach(w => {
      if ((cur ? cur + ' ' + w : w).length > maxChars && cur.length > 0) { lines.push(cur); cur = w; }
      else cur = cur ? cur + ' ' + w : w;
    });
    if (cur) lines.push(cur);
  });
  return lines.filter(Boolean);
}

function hexToASS(hex) {
  const c = hex.replace('#', '');
  return `&H00${c.slice(4,6).toUpperCase()}${c.slice(2,4).toUpperCase()}${c.slice(0,2).toUpperCase()}`;
}

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
    dialogues.push(`Dialogue: 0,0:00:00.00,2:00:00.00,T,,0,0,${Math.max(0, 1920 - (blockTop + (i+1)*lineH))},,${esc(line)}`);
  });
  if (subtitle) {
    const rawSub = subtitle.startsWith('(') ? subtitle : `(${subtitle})`;
    dialogues.push(`Dialogue: 0,0:00:00.00,2:00:00.00,S,,0,0,${Math.max(0, 1920 - (blockTop + titleLines.length*lineH + 6 + subLineH))},,${esc(rawSub)}`);
  }
  fs.writeFileSync(assPath, [
    '[Script Info]','ScriptType: v4.00+','PlayResX: 1080','PlayResY: 1920','WrapStyle: 2','',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: T,Noto Sans,${titleFontSize},${titleASS},${titleASS},&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,3,2,0,0,0,1`,
    `Style: S,Noto Sans,${subFontSize},${subASS},${subASS},&H00000000,&H00000000,1,1,0,0,100,100,0,0,1,1,2,2,0,0,0,1`,
    '','[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...dialogues,
  ].join('\n'), 'utf8');
}

function buildFilterComplex(assPath, config, hasMusic) {
  const { overlayOpacity, musicVolume, keepOrigAudio, origVolume } = config;
  const bf = (1.0 - overlayOpacity * 0.75).toFixed(3);
  const escapedPath = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const fontsDir = path.join(__dirname, 'fonts').replace(/\\/g, '/').replace(/:/g, '\\:');
  const parts = [
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p[s0]`,
    `[s0]colorchannelmixer=rr=${bf}:gg=${bf}:bb=${bf}[dark]`,
    `[dark]format=rgba,subtitles='${escapedPath}':fontsdir='${fontsDir}',format=yuv420p[v]`,
  ];
  let hasAudioOut = false;
  if (keepOrigAudio) {
    if (hasMusic) {
      parts.push(`[0:a]volume=${origVolume}[oa]`);
      parts.push(`[1:a]volume=${musicVolume}[ma]`);
      parts.push('[oa][ma]amix=inputs=2:duration=first:dropout_transition=2[a]');
    } else {
      parts.push(`[0:a]volume=${origVolume}[a]`);
    }
    hasAudioOut = true;
  } else if (hasMusic) {
    parts.push(`[1:a]volume=${musicVolume}[a]`);
    hasAudioOut = true;
  }
  return { fc: parts.join(';'), hasAudioOut };
}

function buildFFmpegArgs(videoPath, musicPath, assPath, config, outputPath) {
  const hasMusic = !!musicPath;
  const { fc, hasAudioOut } = buildFilterComplex(assPath, config, hasMusic);
  const args = ['-i', videoPath];
  if (hasMusic) args.push('-stream_loop', '-1', '-i', musicPath);
  args.push('-filter_complex', fc, '-map', '[v]');
  if (hasAudioOut) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-shortest', '-movflags', '+faststart', '-y', outputPath);
  return args;
}

// ─── Thumbnail ────────────────────────────────────────────────────────────────
function generateThumbnail(videoPath, thumbPath) {
  return new Promise(resolve => {
    const proc = spawn(FFMPEG, [
      '-i', videoPath, '-ss', '00:00:02', '-vframes', '1',
      '-vf', 'scale=320:-1', '-y', thumbPath,
    ], { stdio: 'ignore' });
    proc.on('close', resolve);
  });
}

// ─── AI Content Generation (via 9router) ─────────────────────────────────────
async function generateContentVariations(baseTitle, baseSubtitle, count) {
  const baseUrl = (process.env.NINE_ROUTER_URL || 'http://localhost:20128').replace(/\/$/, '');
  const apiKey  = process.env.NINE_ROUTER_API_KEY;
  const model   = process.env.NINE_ROUTER_MODEL || 'cc/claude-sonnet-4-6';

  if (!apiKey) throw new Error('Chưa cấu hình NINE_ROUTER_API_KEY trong .env. Lấy key từ 9router dashboard.');

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Tạo ${count} biến thể nội dung video ngắn (TikTok/Reels). Giữ chủ đề, đa dạng cách diễn đạt. Chỉ trả về JSON array:
[{"title":"...","subtitle":"..."}]

Tiêu đề gốc: ${baseTitle}
Phụ đề gốc: ${baseSubtitle || '(không có)'}`,
      }],
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`9router error ${res.status}: ${txt.slice(0, 200)}`);
  }

  const data  = await res.json();
  const text  = data.choices?.[0]?.message?.content?.trim() || '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('AI không trả về JSON hợp lệ');
  const arr = JSON.parse(match[0]);
  return Array.isArray(arr) ? arr.slice(0, count) : [];
}

// ─── Batch Processing ─────────────────────────────────────────────────────────
async function processBatch(batchId) {
  const batch = batchJobs.get(batchId);
  if (!batch) return;

  const sourceFiles = fs.readdirSync(SOURCES_DIR).filter(f => VIDEO_EXT.test(f));
  if (!sourceFiles.length) {
    batch.status = 'error';
    batch.items.forEach(it => { it.status = 'error'; it.error = 'Chưa có video nguồn trong folder sources/'; });
    return;
  }

  for (let i = 0; i < batch.items.length; i++) {
    const item = batch.items[i];
    item.status = 'processing';

    const sourceFile = sourceFiles[Math.floor(Math.random() * sourceFiles.length)];
    const videoPath  = path.join(SOURCES_DIR, sourceFile);
    const assPath    = path.join(UPLOAD_DIR, `${randomUUID()}.ass`);
    const outputPath = path.join(OUTPUT_DIR,  `${batchId}_${i}.mp4`);

    try {
      const titleLines = autoWrap(item.title, batch.config.maxChars || 26);
      if (!titleLines.length) throw new Error('Tiêu đề trống');
      generateASS({ ...batch.config, titleLines, subtitle: item.subtitle || '' }, assPath);

      const args = buildFFmpegArgs(videoPath, batch.musicPath, assPath, batch.config, outputPath);
      console.log(`[batch ${batchId.slice(0,6)}] ${i+1}/${batch.items.length} ← ${sourceFile}`);

      await new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => {
          fs.unlink(assPath, () => {});
          if (code === 0 && fs.existsSync(outputPath)) resolve();
          else reject(new Error(stderr.slice(-600)));
        });
      });

      item.status     = 'done';
      item.file       = `${batchId}_${i}.mp4`;
      item.sizeMB     = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
      item.sourceName = sourceFile;
      console.log(`[batch ${batchId.slice(0,6)}] ${i+1} done (${item.sizeMB} MB)`);
    } catch (err) {
      item.status = 'error';
      item.error  = err.message.slice(0, 400);
      fs.unlink(assPath, () => {});
      console.error(`[batch ${batchId.slice(0,6)}] ${i+1} error:`, err.message.slice(0, 200));
    }
  }

  if (batch.musicPath) fs.unlink(batch.musicPath, () => {});
  const doneCount  = batch.items.filter(x => x.status === 'done').length;
  const errorCount = batch.items.filter(x => x.status === 'error').length;
  batch.status = errorCount === batch.items.length ? 'error'
               : doneCount  === batch.items.length ? 'done' : 'partial';
  console.log(`[batch ${batchId.slice(0,6)}] finished: ${doneCount} done, ${errorCount} errors`);
}

// ─── Source Video Management ──────────────────────────────────────────────────

// List source videos
app.get('/api/sources', (req, res) => {
  try {
    const files = fs.readdirSync(SOURCES_DIR)
      .filter(f => VIDEO_EXT.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(SOURCES_DIR, f));
        const thumbName = f.replace(/\.[^.]+$/, '.jpg');
        return {
          name:      f,
          sizeMB:    (stat.size / 1024 / 1024).toFixed(1),
          hasThumb:  fs.existsSync(path.join(THUMBS_DIR, thumbName)),
          createdAt: stat.ctimeMs,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json({ files, count: files.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload source video(s)
app.post('/api/sources/upload', uploadSource.array('video', 50), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Không có file' });
  const results = req.files.map(f => ({
    name:   f.filename,
    sizeMB: (fs.statSync(f.path).size / 1024 / 1024).toFixed(1),
  }));
  // Generate thumbnails in background
  req.files.forEach(f => {
    const thumbPath = path.join(THUMBS_DIR, f.filename.replace(/\.[^.]+$/, '.jpg'));
    generateThumbnail(f.path, thumbPath).catch(() => {});
  });
  res.json({ uploaded: results });
});

// Delete source video
app.delete('/api/sources/:filename', (req, res) => {
  const name = path.basename(req.params.filename);
  const fp   = path.join(SOURCES_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Không tìm thấy' });
  fs.unlinkSync(fp);
  const thumb = path.join(THUMBS_DIR, name.replace(/\.[^.]+$/, '.jpg'));
  if (fs.existsSync(thumb)) fs.unlinkSync(thumb);
  res.json({ ok: true });
});

// Rename source video
app.patch('/api/sources/:filename', (req, res) => {
  const oldName = path.basename(req.params.filename);
  const rawNew  = (req.body.newName || '').trim();
  if (!rawNew) return res.status(400).json({ error: 'Tên không hợp lệ' });

  const ext      = path.extname(oldName);
  const newBase  = rawNew.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_');
  const newName  = newBase + ext;
  const oldPath  = path.join(SOURCES_DIR, oldName);
  const newPath  = path.join(SOURCES_DIR, newName);

  if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'Không tìm thấy' });
  if (fs.existsSync(newPath) && oldName !== newName) return res.status(409).json({ error: 'Tên đã tồn tại' });

  fs.renameSync(oldPath, newPath);
  const oldThumb = path.join(THUMBS_DIR, oldName.replace(/\.[^.]+$/, '.jpg'));
  const newThumb = path.join(THUMBS_DIR, newName.replace(/\.[^.]+$/, '.jpg'));
  if (fs.existsSync(oldThumb)) fs.renameSync(oldThumb, newThumb);

  res.json({ name: newName });
});

// Serve thumbnail
app.get('/api/sources/thumb/:filename', (req, res) => {
  const name = path.basename(req.params.filename).replace(/\.[^.]+$/, '.jpg');
  const fp   = path.join(THUMBS_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.sendFile(fp);
});

// Stream source video (with range support)
app.get('/api/sources/video/:filename', (req, res) => {
  const name = path.basename(req.params.filename);
  const fp   = path.join(SOURCES_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).send('Không tìm thấy');
  streamFile(fp, req, res);
});

// ─── Batch API ────────────────────────────────────────────────────────────────

// Generate AI content
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

// Start batch
app.post('/api/batch', uploadMusic.single('music'), (req, res) => {
  let items;
  try {
    items = JSON.parse(req.body.items || '[]');
    if (!Array.isArray(items) || !items.length) throw new Error();
  } catch {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Danh sách nội dung không hợp lệ' });
  }

  const validItems = items.filter(it => it?.title?.trim());
  if (!validItems.length) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Cần ít nhất 1 video có tiêu đề' });
  }

  const sourceCount = fs.readdirSync(SOURCES_DIR).filter(f => VIDEO_EXT.test(f)).length;
  if (!sourceCount) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Chưa có video nguồn. Hãy upload video vào tab Nguồn Video trước.' });
  }

  const body = req.body;
  const config = {
    overlayOpacity: parseFloat(body.overlayOpacity ?? 0.45),
    musicVolume:    parseFloat(body.musicVolume    ?? 0.65),
    keepOrigAudio:  body.keepOrigAudio === 'true',
    origVolume:     parseFloat(body.origVolume     ?? 0.15),
    textYPercent:   parseFloat(body.textY          ?? 52),
    titleFontSize:  parseInt(body.titleFontSize     ?? 52),
    subFontSize:    parseInt(body.subFontSize        ?? 38),
    titleColor:     body.titleColor  || '#ffffff',
    subColor:       body.subColor    || '#ffff00',
    maxChars:       parseInt(body.maxChars          ?? 26),
  };

  const batchId = randomUUID();
  batchJobs.set(batchId, {
    status:    'processing',
    musicPath: req.file?.path || null,
    config,
    items: validItems.map(it => ({
      title:    it.title.trim(),
      subtitle: it.subtitle?.trim() || '',
      status:   'queued',
    })),
    createdAt: Date.now(),
  });

  res.json({ batchId, total: validItems.length, sourceCount });

  processBatch(batchId).catch(err => {
    console.error('[processBatch unhandled]', err.message);
    const b = batchJobs.get(batchId);
    if (b && b.status === 'processing') b.status = 'error';
  });
});

// Batch status (SSE)
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

// Preview output video
app.get('/api/preview/:filename', (req, res) => {
  const fp = path.join(OUTPUT_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).send('Không tìm thấy');
  streamFile(fp, req, res);
});

// ─── Range-streaming helper ───────────────────────────────────────────────────
function streamFile(fp, req, res) {
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
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎬 Auto Video Creator v3.1 → http://localhost:${PORT}`);
  console.log(`   FFmpeg:    ${FFMPEG}`);
  console.log(`   Sources:   ${SOURCES_DIR}`);
  const nrUrl = process.env.NINE_ROUTER_URL || 'http://localhost:20128';
  const nrKey = process.env.NINE_ROUTER_API_KEY;
  console.log(`   9router:   ${nrKey ? '✓ ' + nrUrl : '✗ NINE_ROUTER_API_KEY not set'}\n`);
});
