import express from 'express';
import multer from 'multer';
import csv from 'csvtojson';
import { authmiddleware, authorizedRole } from '../users/user-middleware.js';
import Reference from './websiteRef-model.js';
import { fetchMainText, generateChunkEmbeddings } from './web_utils.js';  // <- updated import

const Refroutes = express.Router();
const upload = multer({ dest: 'uploads/' }); // Temp folder for CSV uploads

// POST /references/upload
Refroutes.post('/upload', authmiddleware, authorizedRole("admin"), upload.single('file'), async (req, res) => {
  try {
    if (req.file) {
      // Bulk upload via CSV file
      let jsonArray = await csv().fromFile(req.file.path);

      let insertedCount = 0;
      let skippedCount = 0;
      let duplicateUrls = [];

      for (let row of jsonArray) {
        // Skip duplicate source_url if present
        if (row.source_url) {
          const exists = await Reference.findOne({ source_url: row.source_url });
          if (exists) {
            skippedCount++;
            duplicateUrls.push(row.source_url);
            continue;
          }
        }

        // Fetch text if missing, only for references with a URL
        if ((!row.text || row.text.length < 30) && row.source_url) {
          row.text = await fetchMainText(row.source_url);
        }

        // Generate chunked embeddings if missing and text is long enough
        if ((!row.embedding || row.embedding.length === 0) && row.text && row.text.length >= 30) {
          const chunkEmbeddings = await generateChunkEmbeddings(row.text);
          if (!chunkEmbeddings || chunkEmbeddings.length === 0) {
            // Failed to generate embeddings; skip this record
            skippedCount++;
            continue;
          }
          row.embedding = chunkEmbeddings;
        }

        // Only save if we have at least minimal text and embeddings
        if (row.text && row.text.length >= 30 && row.embedding && row.embedding.length > 0) {
          const ref = new Reference(row);
          try {
            await ref.save();
            insertedCount++;
          } catch (err) {
            if (err.code === 11000 && err.keyPattern?.source_url) {
              skippedCount++;
              duplicateUrls.push(row.source_url);
            } else {
              throw err;
            }
          }
        } else {
          skippedCount++;
        }
      }

      return res.status(201).json({
        message: `Bulk upload complete. Inserted ${insertedCount} unique references. Skipped ${skippedCount} (duplicates or insufficient data).`,
        duplicates: duplicateUrls
      });
    } else {
      // Single insert via JSON body
      let {
        type,
        title,
        source_url,
        author,
        publisher,
        year,
        isbn,
        journal,
        volume,
        issue,
        pages,
        text,
        embedding,
      } = req.body;

      // Validation: must have type, title, and either text or URL
      if (!type || !title || (!text && !source_url)) {
        return res.status(400).json({ error: 'type, title and either text or source_url is required' });
      }

      // Check duplicate for URL-based refs
      if (source_url) {
        const existing = await Reference.findOne({ source_url });
        if (existing) {
          return res.status(409).json({ error: 'Reference with this source_url already exists.' });
        }
      }

      // Fetch text if missing
      if (!text && source_url) {
        text = await fetchMainText(source_url);
        if (!text || text.length < 30) {
          return res.status(400).json({ error: 'Failed to extract meaningful text from source_url' });
        }
      }

      // Generate chunked embeddings if missing
      if ((!embedding || embedding.length === 0) && text) {
        const chunkEmbeddings = await generateChunkEmbeddings(text);
        if (!chunkEmbeddings || chunkEmbeddings.length === 0) {
          return res.status(400).json({ error: 'Failed to generate embeddings from text' });
        }
        embedding = chunkEmbeddings;
      }

      const newReference = new Reference({
        type,
        title,
        source_url,
        author,
        publisher,
        year,
        isbn,
        journal,
        volume,
        issue,
        pages,
        text,
        embedding,
        added_at: new Date()
      });

      await newReference.save();

      return res.status(201).json({ message: 'Single reference added successfully', Reference: newReference });
    }
  } catch (error) {
    console.error('Error uploading reference(s):', error);
    if (error.code === 11000 && error.keyPattern?.source_url) {
      return res.status(409).json({ error: 'Reference with this source_url already exists.' });
    }
    res.status(500).json({ error: 'Server error while uploading reference(s)' });
  }
});

export default Refroutes;
