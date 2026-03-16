import config from '../config/config.js';
import logger from '../config/logger.js';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

/** Language code -> search suffix to get videos in that language (relevanceLanguage alone is only a bias). */
const LANGUAGE_SEARCH_SUFFIX = {
  hi: ' hindi',
  es: ' español',
  fr: ' français',
  de: ' deutsch',
  pt: ' português',
  ar: ' عربي',
  zh: ' 中文',
  ja: ' 日本語',
  te: ' తెలుగు',
  ta: ' தமிழ்',
  mr: ' मराठी',
  bn: ' বাংলা',
  kn: ' ಕನ್ನಡ',
  ml: ' മലയാളം',
};

/**
 * @param {string} topic - Search query
 * @param {number} maxResults - Max videos to return
 * @param {string} [relevanceLanguage='en'] - ISO 639-1 two-letter language code for YouTube relevanceLanguage (e.g. 'en', 'hi', 'es')
 */
export async function searchVideos(topic, maxResults = 4, relevanceLanguage = 'en') {
  const apiKey = config.youtube?.apiKey;
  if (!apiKey) {
    logger.warn('GCP_YOUTUBE_API_KEY not set — skipping video search. Add GCP_YOUTUBE_API_KEY to .env');
    return [];
  }

  const lang = (relevanceLanguage || 'en').trim().toLowerCase().slice(0, 2) || 'en';
  const suffix = lang === 'en' ? '' : (LANGUAGE_SEARCH_SUFFIX[lang] || ` ${lang}`);
  const searchQuery = (topic + suffix).trim();
  try {
    const url = `${YOUTUBE_API_BASE}/search?part=snippet&type=video&maxResults=${maxResults}&q=${encodeURIComponent(searchQuery)}&key=${apiKey}&relevanceLanguage=${encodeURIComponent(lang)}&videoEmbeddable=true`;
    logger.debug(`[YouTube] Searching: "${searchQuery}" (max ${maxResults}, language: ${lang})`);
    const res = await fetch(url);
    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      logger.error('[YouTube] Search API failed', { status: res.status, error: errorText.slice(0, 500), query: topic });
      return [];
    }
    const data = await res.json();
    const videoIds = (data.items || []).map((i) => i.id?.videoId).filter(Boolean);
    logger.debug(`[YouTube] Found ${videoIds.length} video(s) for "${topic}"`);
    if (!videoIds.length) return [];
    return getVideoDetails(videoIds);
  } catch (err) {
    logger.error('[YouTube] Search error', { message: err.message, query: topic });
    return [];
  }
}

export async function getVideoDetails(videoIds) {
  const apiKey = config.youtube?.apiKey;
  if (!apiKey || !videoIds.length) return [];

  try {
    const url = `${YOUTUBE_API_BASE}/videos?part=snippet,contentDetails&id=${videoIds.join(',')}&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      logger.error('[YouTube] Video details API failed', { status: res.status, error: errorText.slice(0, 500) });
      return [];
    }
    const data = await res.json();
    const results = (data.items || []).map((item) => ({
      youtubeUrl: `https://www.youtube.com/watch?v=${item.id}`,
      title: item.snippet?.title ?? '',
      description: (item.snippet?.description ?? '').slice(0, 500),
      duration: parseDuration(item.contentDetails?.duration ?? ''),
    }));
    logger.debug(`[YouTube] Got details for ${results.length} video(s)`);
    return results;
  } catch (err) {
    logger.error('[YouTube] Video details error', { message: err.message });
    return [];
  }
}

function parseDuration(iso) {
  // PT1H2M30S -> minutes
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return parseInt(m[1] || '0', 10) * 60 + parseInt(m[2] || '0', 10) + Math.ceil(parseInt(m[3] || '0', 10) / 60);
}
