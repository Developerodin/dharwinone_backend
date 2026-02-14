import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as blogOpenAIService from '../services/blogOpenAI.service.js';

const generate = catchAsync(async (req, res) => {
  const { mode, existingContent, title, keywords, wordCount, format } = req.body;
  const content = await blogOpenAIService.generateBlog({
    mode,
    existingContent,
    title,
    keywords,
    wordCount,
    format,
  });
  res.status(httpStatus.OK).json({ content });
});

const generateFromTheme = catchAsync(async (req, res) => {
  const { theme, index, total, keywords, wordCount, format } = req.body;
  const result = await blogOpenAIService.generateBlogFromTheme({
    theme,
    index,
    total,
    keywords,
    wordCount,
    format,
  });
  res.status(httpStatus.OK).json(result);
});

const getSuggestions = catchAsync(async (req, res) => {
  const { content, format } = req.body;
  const result = await blogOpenAIService.getBlogSuggestions({ content, format });
  res.status(httpStatus.OK).json(result);
});

const generateStream = catchAsync(async (req, res) => {
  const { mode, existingContent, title, keywords, wordCount, format } = req.body;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  try {
    for await (const event of blogOpenAIService.generateBlogStream({
      mode,
      existingContent,
      title,
      keywords,
      wordCount,
      format,
    })) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message || 'Stream failed' })}\n\n`);
  } finally {
    res.end();
  }
});

export { generate, generateFromTheme, getSuggestions, generateStream };
