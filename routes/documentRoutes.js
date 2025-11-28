// routes/documentRoutes.js

const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('../config/cloudinary'); // Asumiendo que tienes un archivo de config para cloudinary
const GlobalDocument = require('../models/GlobalDocuments');
const { protect, isAdmin } = require('../middleware/authMiddleware');
const { createVectorsForDocument } = require('../utils.js'); // Importamos la función "todo en uno"
const { Pinecone } = require('@pinecone-database/pinecone');

// Inicializar Pinecone (solo para este contexto)
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const pineconeIndex = pinecone.index('chat-rag');

// Usar almacenamiento en memoria para pasar los archivos directamente a Cloudinary
const upload = multer({ storage: multer.memoryStorage() });

// --- RUTA 1: Subir nuevos documentos globales (CREATE) ---
router.post('/upload', protect, isAdmin, upload.array('documents'), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: 'No se han proporcionado archivos.' });
    }
    try {
        for (const file of req.files) {
            // 1. Subir el archivo original a Cloudinary para poder visualizarlo después
            const uploadResult = await new Promise((resolve, reject) => {
                const uploadStream = cloudinary.uploader.upload_stream({ resource_type: "raw", folder: "global_documents" }, (error, result) => {
                    if (error) return reject(error);
                    resolve(result);
                });
                uploadStream.end(file.buffer);
            });

            // 2. Usar nuestra función centralizada de utils.js para procesar y crear los vectores
            const documentId = `global_${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
            const vectorsToUpsert = await createVectorsForDocument(file, documentId);

            // 3. Guardar en Pinecone y MongoDB
            if (vectorsToUpsert.length > 0) {
                await pineconeIndex.upsert(vectorsToUpsert);
                await GlobalDocument.create({
                    documentId,
                    originalName: file.originalname,
                    cloudinaryUrl: uploadResult.secure_url,
                    cloudinaryPublicId: uploadResult.public_id,
                    chunkCount: vectorsToUpsert.length,
                    uploadedBy: req.user._id
                });
            }
        }
        res.status(201).json({ message: 'Archivos procesados y subidos con éxito.' });
    } catch (error) {
        console.error('[CRUD Admin] Error en la subida:', error);
        res.status(500).json({ message: 'Error en el servidor al subir archivos.', details: error.message });
    }
});

// --- RUTA 2: Obtener la lista de documentos globales (READ) ---
router.get('/', protect, isAdmin, async (req, res) => {
    try {
        const documents = await GlobalDocument.find({}).sort({ createdAt: -1 }).populate('uploadedBy', 'name email');
        res.status(200).json(documents);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener los documentos.' });
    }
});

// --- RUTA 3: Borrar un documento global (DELETE) ---
router.delete('/:id', protect, isAdmin, async (req, res) => {
    try {
        const docToDelete = await GlobalDocument.findById(req.params.id);
        if (!docToDelete) return res.status(404).json({ message: 'Documento no encontrado.' });
        
        await pineconeIndex.deleteMany({ documentId: docToDelete.documentId });
        if (docToDelete.cloudinaryPublicId) {
            await cloudinary.uploader.destroy(docToDelete.cloudinaryPublicId, { resource_type: "raw" });
        }
        await docToDelete.deleteOne();

        res.status(200).json({ message: `Documento "${docToDelete.originalName}" eliminado.` });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar el documento.', details: error.message });
    }
});

module.exports = router;