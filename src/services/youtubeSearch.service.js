import config from '../config/config.js';
import logger from '../config/logger.js';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

export async function searchVideos(topic, maxResults = 4) {
  const apiKey = config.youtube?.apiKey;
  if (!apiKey) {
    logger.warn('YOUTUBE_API_KEY not set, skipping video search');
    return [];
  }

  const url = `${YOUTUBE_API_BASE}/search?part=snippet&type=video&maxResults=${maxResults}&q=${encodeURIComponent(topic)}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    logger.error('YouTube search failed', { status: res.status });
    return [];
  }
  const data = await res.json();
  const videoIds = (data.items || []).map((i) => i.id?.videoId).filter(Boolean);
  if (!videoIds.length) return [];
  return getVideoDetails(videoIds);
}

export async function getVideoDetails(videoIds) {
  const apiKey = config.youtube?.apiKey;
  if (!apiKey || !videoIds.length) return [];

  const url = `${YOUTUBE_API_BASE}/videos?part=snippet,contentDetails&id=${videoIds.join(',')}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || []).map((item) => ({
    youtubeUrl: `https://www.youtube.com/watch?v=${item.id}`,
    title: item.snippet?.title ?? '',
    description: (item.snippet?.description ?? '').slice(0, 500),
    duration: parseDuration(item.contentDetails?.duration ?? ''),
  }));
}

function parseDuration(iso) {
  // PT1H2M30S -> minutes
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return parseInt(m[1] || '0', 10) * 60 + parseInt(m[2] || '0', 10) + Math.ceil(parseInt(m[3] || '0', 10) / 60);
}
