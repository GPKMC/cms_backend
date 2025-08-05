import mongoose from 'mongoose';
const { Schema } = mongoose;

const referenceSchema = new Schema({
  type: {
    type: String,
    enum: ['website', 'book', 'article', 'journal', 'other'],
    required: true,
  },
  title: { type: String, required: true },
  source_url: { type: String },
  author: { type: String },
  publisher: { type: String },
  year: { type: Number },
  isbn: { type: String },
  journal: { type: String },
  volume: { type: String },
  issue: { type: String },
  pages: { type: String },
  text: { type: String },
  // Change embedding to array of arrays of numbers (chunk embeddings)
  embedding: {
    type: [[Number]],
    default: []
  },
  added_at: { type: Date, default: Date.now }
});

export default mongoose.model('Reference', referenceSchema);
