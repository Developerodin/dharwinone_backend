import OpenAI from 'openai';
import config from '../config/config.js';
import logger from '../config/logger.js';

function getOpenAIClient() {
  const apiKey = config.openai?.apiKey;
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

/**
 * Generate cover image using DALL-E 3 from the course topic.
 * Uses OPENAI_API_KEY (same as blog generation).
 */
export async function fetchCoverImage(topic) {
  const client = getOpenAIClient();
  if (!client) {
    logger.info('OPENAI_API_KEY not set; cover image generation skipped.');
    return null;
  }

  const subject = (topic || 'training').trim();
  const prompt = `Professional, modern cover image for an online course about "${subject}". Clean, educational, suitable for e-learning. High quality, no text or words in the image.`;

  try {
    const response = await client.images.generate({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1792x1024',
      quality: 'standard',
      response_format: 'b64_json',
    });

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) return null;

    const buffer = Buffer.from(b64, 'base64');
    return {
      buffer,
      originalname: `cover-${Date.now()}.png`,
      mimetype: 'image/png',
      size: buffer.length,
    };
  } catch (err) {
    logger.warn('DALL-E cover image generation failed', err);
    return null;
  }
}
