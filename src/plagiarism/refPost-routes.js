import express from 'express';
import multer from 'multer';
import csv from 'csvtojson';
import { authmiddleware, authorizedRole } from '../users/user-middleware.js';
import websiteRefModel from './websiteRef-model.js';

const Refroutes = express.Router();
const upload = multer({ dest: 'uploads/' }); // Temp folder for CSV uploads

// POST /references/upload
// If req has file => parse CSV and bulk insert
// Else => create single reference from JSON body
Refroutes.post('/upload',authmiddleware,authorizedRole("admin"), upload.single('file'), async (req, res) => {
  try {
    if (req.file) {
      // Bulk upload via CSV file
      const jsonArray = await csv().fromFile(req.file.path);

      // Optional: Map CSV fields to Reference model fields if needed
      // jsonArray = jsonArray.map(row => ({ type: row.Type, title: row.Title, ... }));

      const insertedRefs = await websiteRefModel.insertMany(jsonArray);

      return res.status(201).json({ message: `Bulk upload successful. Inserted ${insertedRefs.length} references.` });
    } else {
      // Single insert via JSON body
      const {
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
        embedding
      } = req.body;

      // Simple validation
      if (!type || !title || !text) {
        return res.status(400).json({ error: 'type, title and text fields are required' });
      }

      const newReference = new websiteRefModel({
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

      return res.status(201).json({ message: 'Single reference added successfully', websiteRefModel: newReference });
    }
  } catch (error) {
    console.error('Error uploading reference(s):', error);
    res.status(500).json({ error: 'Server error while uploading reference(s)' });
  }
});

export default Refroutes;
