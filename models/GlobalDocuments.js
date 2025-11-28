const mongoose = require('mongoose');

const globalDocumentSchema = new mongoose.Schema({
  documentId: { type: String, required: true, unique: true },
  originalName: { type: String, required: true },
  
  // --- CAMBIO CLAVE ---
  // Hacemos que estos campos NO sean obligatorios.
  cloudinaryUrl: { type: String, required: false },
  cloudinaryPublicId: { type: String, required: false },

  uploadedBy: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  chunkCount: { type: Number, required: true }
}, { timestamps: true });

module.exports = mongoose.model('GlobalDocument', globalDocumentSchema);