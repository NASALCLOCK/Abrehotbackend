const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const ffprobe = require('ffprobe-static');

const MAX_DURATION_SECONDS = 30;

async function inspectIntroVideo(buffer, extension) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'abrehot-intro-video-'));
  const filePath = path.join(directory, 'intro' + extension);
  try {
    await fs.writeFile(filePath, buffer);
    const output = await new Promise((resolve, reject) => {
      execFile(ffprobe.path, [
        '-v', 'error',
        '-show_entries', 'format=duration,format_name:stream=codec_type,duration',
        '-of', 'json',
        filePath,
      ], { timeout: 15000, maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error) {
          if (error.code === 1) {
            const invalidVideo = new Error('The video file is invalid or could not be read.');
            invalidVideo.statusCode = 400;
            return reject(invalidVideo);
          }
          return reject(error);
        }
        resolve(stdout);
      });
    });
    const result = JSON.parse(output);
    const metadata = result.format || {};
    const videoDurations = (result.streams || [])
      .filter((stream) => stream.codec_type === 'video')
      .map((stream) => Number(stream.duration))
      .filter(Number.isFinite);
    const duration = Math.max(Number(metadata.duration) || 0, ...videoDurations);
    const formats = String(metadata.format_name || '').split(',');
    const validContainer = extension === '.mp4'
      ? formats.some((format) => ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'].includes(format))
      : formats.some((format) => ['matroska', 'webm'].includes(format));
    if (!validContainer || !videoDurations.length || !Number.isFinite(duration) || duration <= 0) {
      const error = new Error('The video file is invalid or could not be read.');
      error.statusCode = 400;
      throw error;
    }
    if (duration > MAX_DURATION_SECONDS) {
      const error = new Error('Intro videos must be 30 seconds or shorter.');
      error.statusCode = 400;
      throw error;
    }
    return duration;
  } catch (error) {
    if (error.statusCode) throw error;
    if (error instanceof SyntaxError) {
      const invalidVideo = new Error('The video file is invalid or could not be read.');
      invalidVideo.statusCode = 400;
      throw invalidVideo;
    }
    throw error;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function sendIntroVideo(req, res, video) {
  const size = video.fileData.length;
  const contentType = video.contentType;
  const range = req.headers.range;
  res.set({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=300',
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  });
  if (!range) {
    res.set('Content-Length', size);
    return res.status(200).send(video.fileData);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) {
    res.set('Content-Range', 'bytes */' + size);
    return res.status(416).end();
  }
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    res.set('Content-Range', 'bytes */' + size);
    return res.status(416).end();
  }
  end = Math.min(end, size - 1);
  res.status(206);
  res.set({
    'Content-Length': end - start + 1,
    'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
  });
  return res.send(video.fileData.subarray(start, end + 1));
}

module.exports = { inspectIntroVideo, sendIntroVideo, MAX_DURATION_SECONDS };
