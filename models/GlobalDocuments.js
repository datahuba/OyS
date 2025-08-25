const mongoose = require('mongoose');

// Este esquema es muy similar al 'documentDetailSchema'
const globalDocumentSchema = new mongoose.Schema({
  documentId: { type: String, required: true, unique: true }, // ID que enlaza con Pinecone
  originalName: { type: String, required: true },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' }, // Para saber qué admin lo subió
  chunkCount: { type: Number, required: true }
}, { timestamps: true });

module.exports = mongoose.model('GlobalDocument', globalDocumentSchema);