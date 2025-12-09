// routes/documentRoutes.js

const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('../config/cloudinary');
const GlobalDocument = require('../models/GlobalDocuments');
const { protect, isAdmin } = require('../middleware/authMiddleware');
const { extractTextFromFile, chunkDocument, getEmbedding } = require('../utils.js'); // Usar las mismas funciones que en server.js
const { Pinecone } = require('@pinecone-database/pinecone');

// Inicializar Pinecone (solo para este contexto)
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const pineconeIndex = pinecone.index('chat-rag');

// Usar almacenamiento en memoria para pasar los archivos directamente a Cloudinary
// Aumentamos el límite a 50 MB para documentos grandes
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024 // 50 MB en bytes
    }
});

// --- RUTA 1: Subir nuevos documentos globales (CREATE) ---
router.post('/upload', protect, isAdmin, upload.array('documents'), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: 'No se han proporcionado archivos.' });
    }

    const results = [];
    const errors = [];

    try {
        for (const file of req.files) {
            try {
                console.log(`[Global Docs] Procesando: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

                // PASO 1: Extraer texto del archivo (igual que en server.js)
                const text = await extractTextFromFile(file);
                if (!text || !text.trim()) {
                    console.warn(`[Global Docs] ✗ ${file.originalname} - No se pudo extraer texto`);
                    errors.push({ filename: file.originalname, error: 'No se pudo extraer texto del archivo' });
                    continue;
                }
                console.log(`[Global Docs] ✓ Texto extraído: ${text.length} caracteres`);

                // PASO 2: Dividir en chunks (igual que en server.js)
                const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                const documentId = `global_${Date.now()}_${sanitizedFilename}`;
                const chunks = chunkDocument(text);
                console.log(`[Global Docs] ✓ ${chunks.length} chunks creados`);

                // PASO 3: Crear vectores (igual que en server.js)
                const vectorsToUpsert = await Promise.all(
                    chunks.map(async (chunk, index) => ({
                        id: `${documentId}_chunk_${index}`,
                        values: await getEmbedding(chunk),
                        metadata: { documentId, chunkText: chunk },
                    }))
                );
                console.log(`[Global Docs] ✓ ${vectorsToUpsert.length} vectores generados`);

                // PASO 4: Subir a Cloudinary
                const uploadResult = await new Promise((resolve, reject) => {
                    const uploadStream = cloudinary.uploader.upload_stream({
                        resource_type: "raw",
                        folder: "global_documents"
                    }, (error, result) => {
                        if (error) return reject(error);
                        resolve(result);
                    });
                    uploadStream.end(file.buffer);
                });
                console.log(`[Global Docs] ✓ Subido a Cloudinary`);

                // PASO 5: Guardar en Pinecone
                await pineconeIndex.upsert(vectorsToUpsert);
                console.log(`[Global Docs] ✓ Guardado en Pinecone`);

                // PASO 6: Guardar en MongoDB
                await GlobalDocument.create({
                    documentId,
                    originalName: file.originalname,
                    cloudinaryUrl: uploadResult.secure_url,
                    cloudinaryPublicId: uploadResult.public_id,
                    chunkCount: vectorsToUpsert.length,
                    uploadedBy: req.user._id
                });
                console.log(`[Global Docs] ✓ Guardado en MongoDB`);

                results.push({
                    filename: file.originalname,
                    status: 'success',
                    chunks: vectorsToUpsert.length
                });
                console.log(`[Global Docs] ✅ ${file.originalname} procesado completamente`);

            } catch (fileError) {
                console.error(`[Global Docs] ❌ Error en ${file.originalname}:`, fileError.message);
                errors.push({
                    filename: file.originalname,
                    error: fileError.message
                });
            }
        }

        // Responder con el resumen de resultados
        if (results.length > 0 && errors.length === 0) {
            res.status(201).json({
                message: 'Todos los archivos fueron procesados exitosamente.',
                results
            });
        } else if (results.length > 0 && errors.length > 0) {
            res.status(207).json({
                message: `${results.length} archivo(s) procesado(s), ${errors.length} con errores.`,
                results,
                errors
            });
        } else {
            res.status(400).json({
                message: 'No se pudo procesar ningún archivo.',
                errors
            });
        }

    } catch (error) {
        console.error('[CRUD Admin] Error general:', error);
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