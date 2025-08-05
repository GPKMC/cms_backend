import fetch from 'node-fetch';
import { load } from 'cheerio';
import { HfInference } from '@huggingface/inference';

const hf = new HfInference(process.env.HUGGINGFACE_TOKEN);

// Helper: split text into chunks of max length (e.g., 256 tokens or chars)
function chunkText(text, maxChunkLength = 256) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxChunkLength;
    if (end > text.length) end = text.length;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * Fetches main textual content from a given URL, prioritizing <p> tags.
 * If no <p> tags, tries to get meaningful text from the body.
 * @param {string} url
 * @returns {Promise<string|null>} Cleaned text or null if failed
 */
export async function fetchMainText(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    const html = await res.text();
    const $ = load(html);
    // Prefer <p> tags
    let paragraphs = $('p').map((i, el) => $(el).text()).get();
    let text = paragraphs.join(' ').trim();

    // Fallback: Try getting text from <body> if <p> is empty
    if (!text || text.length < 30) {
      text = $('body').text().replace(/\s+/g, ' ').trim();
    }

    // Final cleanup: Remove very short texts
    if (!text || text.length < 30) return null;
    // Optionally truncate to 4096 chars (safe for BERT API)
    return text.slice(0, 4096);
  } catch (err) {
    console.error(`Error fetching main text for URL ${url}:`, err.message);
    return null;
  }
}

/**
 * Generates chunked embeddings for the given text using HuggingFace Inference API.
 * Splits text into chunks and generates embedding per chunk.
 * @param {string} text
 * @param {number} chunkSize max characters per chunk (default 256)
 * @returns {Promise<number[][]|null>} Array of embeddings or null on failure
 */
export async function generateChunkEmbeddings(text, chunkSize = 256) {
  try {
    if (!text || typeof text !== 'string' || !text.trim()) return null;

    // Split text into chunks
    const chunks = chunkText(text, chunkSize);

    // Generate embeddings for each chunk sequentially (can be parallelized if needed)
    const embeddings = [];
    for (const chunk of chunks) {
      // truncate chunk to max 4096 chars just in case
      const safeChunk = chunk.slice(0, 4096);

      const embedding = await hf.featureExtraction({
        model: 'sentence-transformers/all-MiniLM-L6-v2',
        inputs: safeChunk,
      });

      if (!Array.isArray(embedding)) {
        throw new Error('Embedding is not an array');
      }

      embeddings.push(embedding);
    }

    return embeddings; // array of arrays of numbers
  } catch (err) {
    console.error('Error generating chunk embeddings:', err.message);
    return null;
  }
}
