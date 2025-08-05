// import fetch from 'node-fetch';
// import { load } from 'cheerio';
// import { HfInference } from '@huggingface/inference';

// import mongoose from 'mongoose';
// import websiteRefModel from './websiteRef-model.js ';

// const hf = new HfInference(process.env.HUGGINGFACE_URL);

// /**
//  * Fetches main textual content from the URL by extracting <p> paragraphs.
//  * @param {string} url
//  * @returns {string|null} extracted text or null on failure
//  */
// async function fetchMainText(url) {
//   try {
//     const res = await fetch(url);
//     if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
//     const html = await res.text();
// const $ = load(html);
//     const paragraphs = $('p').map((i, el) => $(el).text()).get();
//     return paragraphs.join(' ').trim();
//   } catch (err) {
//     console.error(`Error fetching main text for URL ${url}:`, err.message);
//     return null;
//   }
// }

// /**
//  * Generates average embedding vector for the given text using HuggingFace Inference API.
//  * @param {string} text
//  * @returns {number[]|null} average embedding vector or null on failure
//  */
// async function generateEmbedding(text) {
//   try {
//     const embedding = await hf.featureExtraction({
//       model: 'sentence-transformers/all-MiniLM-L6-v2',
//       inputs: text,
//     });

//     // embedding is already an array of floats (1D) for the whole input text
//     // so just return it directly
//     return embedding;
//   } catch (err) {
//     console.error('Error generating embedding:', err.message);
//     return null;
//   }
// }


// /**
//  * Main processing function:
//  * Finds references missing text or embedding,
//  * fetches and generates embeddings, then updates MongoDB.
//  */
// export async function processReferences() {


//   const query = {
//     $or: [
//       { text: { $exists: false } },
//       { text: '' },
//       { embedding: { $exists: false } },
//       { embedding: { $size: 0 } },
//     ],
//     source_url: { $exists: true, $ne: '' },
//   };

//   const docs = await websiteRefModel.find(query);
//   console.log(`Found ${docs.length} references to process.`);

//   for (const doc of docs) {
//     console.log(`Processing URL: ${doc.source_url}`);

//     const text = await fetchMainText(doc.source_url);
//     if (!text || text.length < 50) {
//       console.log(`Skipping URL due to insufficient or empty text.`);
//       continue;
//     }

//     const embedding = await generateEmbedding(text);
//     if (!embedding) {
//       console.log(`Failed to generate embedding.`);
//       continue;
//     }

//     doc.text = text;
//     doc.embedding = embedding;
//     await doc.save();
//     console.log(`Updated document with _id: ${doc._id}`);
//   }
// }
