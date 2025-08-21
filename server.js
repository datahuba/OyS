require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const fs =require('fs');
const multer = require('multer');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pinecone } = require('@pinecone-database/pinecone'); // <-- CORRECCIÓN: Importar Pinecone

// Importaciones de nuestro proyecto
const { protect } = require('./middleware/authMiddleware');
const userRoutes = require('./routes/userRoutes');
const Chat = require('./models/Chat');

const app = express();
const PORT = process.env.PORT || 5000;

// Middlewares globales
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Conexión a la Base de Datos
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB conectado exitosamente.'))
  .catch(err => console.error('Error al conectar a MongoDB:', err));

// --- INICIALIZACIÓN DE SERVICIOS DE IA Y DBs ---

// Modelos de Google AI
const GOOGLE_AI_STUDIO_API_KEY = process.env.GOOGLE_AI_STUDIO_API_KEY;
const genAI = new GoogleGenerativeAI(GOOGLE_AI_STUDIO_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: "embedding-001" });
const generativeModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// <-- CORRECCIÓN: Inicializar Pinecone
const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY,
});
const pineconeIndex = pinecone.index('chat-rag'); 
console.log("Conectado y listo para usar el índice de Pinecone: 'chat-rag'.");


// --- MONTAR RUTAS DE USUARIO ---
app.use('/api/users', userRoutes);

// --- LÓGICA DE DETECCIÓN DE CONTEXTO POR EMBEDDINGS ---
const SIMILARITY_THRESHOLD = 0.8;
const CONTEXT_TRIGGERS = [
    {
        contextName: 'compatibilizacion',
        triggerPhrase: 'compatibilización de formularios',
        responseMessage: 'Cambiando el contexto a "Compatibilización".'
    },
    {
        contextName: 'consolidadoFacultades',
        triggerPhrase: 'consolidado de facultades',
        responseMessage: 'Cambiando el contexto a "Consolidado de Facultades".'
    },
    {
        contextName: 'consolidadoAdministrativo',
        triggerPhrase: 'consolidado de administrativos',
        responseMessage: 'Cambiando el contexto a "Consolidado de Administrativos".'
    },
    {
        contextName: 'miscellaneous',
        triggerPhrase: 'terminadar proceso',
        responseMessage: 'Volviendo al contexto general del chat.'
    }
];
let triggerEmbeddings = {};
(async () => {
    try {
        console.log("Pre-calculando embeddings para las frases de activación de contexto...");
        for (const trigger of CONTEXT_TRIGGERS) {
            const result = await embeddingModel.embedContent(trigger.triggerPhrase);
            triggerEmbeddings[trigger.contextName] = {
                embedding: result.embedding.values,
                responseMessage: trigger.responseMessage
            };
        }
        console.log("Embeddings de contexto calculados exitosamente.");
    } catch (error) {
        console.error("Error crítico: no se pudo pre-calcular los embeddings de activación.", error);
    }
})();

const upload = multer({ dest: 'uploads/' });

// --- SUBPROCESOS Y FUNCIONES AUXILIARES ---

async function detectAndHandleContextSwitch(chat, userQuery, res) {
    const userQueryEmbedding = await getEmbedding(userQuery);
    for (const contextName in triggerEmbeddings) {
        const trigger = triggerEmbeddings[contextName];
        const similarity = cosineSimilarity(userQueryEmbedding, trigger.embedding);
        if (similarity > SIMILARITY_THRESHOLD && chat.activeContext !== contextName) {
            try {
                console.log(`✅ Intención detectada en [${chat._id}]: Cambiar contexto a -> ${contextName}`);
                const updatedChat = await Chat.findByIdAndUpdate(chat._id, {
                    activeContext: contextName,
                    $push: { messages: { $each: [
                        { sender: 'user', text: userQuery },
                        { sender: 'ai', text: trigger.responseMessage }
                    ]}}
                }, { new: true });

                res.status(200).json({ updatedChat });
                return true;
            } catch (dbError) {
                console.error("Error al cambiar el contexto del chat:", dbError);
                res.status(500).json({ message: "Error al procesar el cambio de contexto." });
                return true;
            }
        }
    }
    return false;
}

function getDocumentsForActiveContext(chat) {
    const contextKey = chat.activeContext;
    if (chat[contextKey] && Array.isArray(chat[contextKey])) {
        return chat[contextKey].map(doc => doc.documentId);
    }
    return [];
}


const findRelevantChunksAcrossDocuments = async (queryEmbedding, documentIds, topK = 5) => {
    if (!documentIds || documentIds.length === 0) return [];
    try {
        const queryResponse = await pineconeIndex.query({
            topK,
            vector: queryEmbedding,
            filter: { documentId: { "$in": documentIds } },
            includeMetadata: true,
        });
        if (queryResponse.matches?.length) {
            return queryResponse.matches.map(match => match.metadata.chunkText);
        }
        return [];
    } catch (error) {
        console.error("[Pinecone] Error al realizar la búsqueda:", error);
        return [];
    }
};

// --- OTRAS FUNCIONES AUXILIARES
async function extractTextWithGemini(filePath, mimetype) {
    const fileBuffer = fs.readFileSync(filePath);

    // 1. Prepara el archivo para el SDK. El SDK se encarga de la codificación Base64.
    const filePart = {
        inlineData: {
            data: fileBuffer.toString("base64"),
            mimeType: mimetype,
        },
    };

    const prompt = "Extrae todo el texto de este documento. Devuelve únicamente el texto plano, sin ningún formato adicional.";

    try {
        // 2. Llama a la API usando el modelo generativo del SDK. Es más simple y robusto.
        const result = await generativeModel.generateContent([prompt, filePart]);
        const response = result.response;
        const text = response.text();
        return text;
    } catch (error) {
    // ESTA LÍNEA ES LA CLAVE DE TODO
    console.error('Error detallado de la API de Gemini:', error); 
    
    throw new Error('La API de Gemini no pudo procesar el archivo.');

    }
}

// CÓDIGO CORREGIDO Y LISTO PARA USAR

const supportedClientTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    'application/msword', // .doc
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'application/vnd.ms-excel', // .xls
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
    'application/vnd.ms-powerpoint', // .ppt
    'text/plain', // .txt
    'text/csv', // .csv
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif'
];
const geminiMimeTypeMapper = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'application/msword',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'application/vnd.ms-powerpoint'
};
const extractTextFromFile = async (file) => {
    const filePath = file.path;
    const clientMimeType = file.mimetype; // El tipo de archivo real que subió el usuario
    let text = '';

    // 3. Primero, validamos si el archivo es de un tipo que hemos decidido soportar.
    if (supportedClientTypes.includes(clientMimeType)) {
        
        // 4. Decidimos qué MIME type enviaremos a la API de Gemini.
        // Buscamos en nuestro traductor. Si no hay una traducción, usamos el tipo original (ideal para PDF, TXT, imágenes).
        const apiMimeType = geminiMimeTypeMapper[clientMimeType] || clientMimeType;

        console.log(`Archivo recibido: ${clientMimeType}. Enviando a Gemini como: ${apiMimeType}...`);
        
        // 5. Llamamos a la función de extracción con el tipo de archivo correcto para la API.
        text = await extractTextWithGemini(filePath, apiMimeType);

    } else {
        // Si el tipo no está en nuestra lista, lo rechazamos.
        console.error(`Tipo de archivo no soportado: ${clientMimeType}`);
        throw new Error('Tipo de archivo no soportado.');
    }
    
    return text;
};
const getEmbedding = async (text) => { const result = await embeddingModel.embedContent(text); return result.embedding.values; };
const chunkDocument = (text, chunkSize = 1000, overlap = 200) => { const chunks = []; for (let i = 0; i < text.length; i += chunkSize - overlap) { chunks.push(text.substring(i, i + chunkSize)); } return chunks; };
const cosineSimilarity = (vecA, vecB) => { let dotProduct = 0, magA = 0, magB = 0; for(let i=0;i<vecA.length;i++){ dotProduct += vecA[i]*vecB[i]; magA += vecA[i]*vecA[i]; magB += vecB[i]*vecB[i]; } magA = Math.sqrt(magA); magB = Math.sqrt(magB); if(magA===0||magB===0)return 0; return dotProduct/(magA*magB); };


// --- RUTAS DE LA API ---

app.get('/api/chats', protect, async (req, res) => {
    try {
        const chats = await Chat.find({ userId: req.user._id }).select('_id title updatedAt').sort({ updatedAt: -1 });
        res.json(chats);
    } catch (error) { res.status(500).json({ message: 'Error al obtener chats', error: error.message }); }
});


app.get('/api/chats/:id', protect, async (req, res) => {

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'ID de chat inválido' });
    try {
        const chat = await Chat.findOne({ _id: req.params.id, userId: req.user._id });
        if (!chat) return res.status(404).json({ message: 'Chat no encontrado o no autorizado' });
        res.json(chat);
    } catch (error) { res.status(500).json({ message: 'Error al obtener chat', error: error.message }); }
});

app.post('/api/chats', protect, async (req, res) => {
    try {
        const newChat = new Chat({ title: 'Nuevo Chat', messages: [], userId: req.user._id });
        await newChat.save();
        res.status(201).json(newChat);
    } catch (error) { res.status(500).json({ message: 'Error al crear chat', error: error.message }); }
});

app.delete('/api/chats/:id', protect, async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'ID de chat inválido' });
    try {
        const chat = await Chat.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
        if (!chat) return res.status(404).json({ message: "Chat no encontrado o no autorizado" });
        res.json({ message: 'Chat eliminado exitosamente' });
    } catch (error) { res.status(500).json({ message: "Error interno al eliminar el chat." }); }
});

app.post('/api/process-document', protect, upload.single('file'), async (req, res) => {
    const { chatId, documentType } = req.body;
    if (!req.file || !chatId || !documentType) {
        return res.status(400).json({ message: 'Falta archivo, ID del chat o tipo de documento.' });
    }
    const allowedTypes = ['compatibilizacion', 'consolidadoFacultades', 'consolidadoAdministrativo', 'miscellaneous'];
    if (!allowedTypes.includes(documentType)) {
        return res.status(400).json({ message: 'Tipo de documento inválido.' });
    }
    
    try {
        const text = await extractTextFromFile(req.file);
        if (!text || !text.trim()) throw new Error('No se pudo extraer texto del documento.');
        
        const documentId = `doc_${chatId}_${Date.now()}`;
        const chunks = chunkDocument(text);
        
        const vectorsToUpsert = await Promise.all(
            chunks.map(async (chunk, index) => ({
                id: `${documentId}_chunk_${index}`,
                values: await getEmbedding(chunk),
                metadata: { documentId, chunkText: chunk },
            }))
        );
        
        await pineconeIndex.upsert(vectorsToUpsert);
        console.log(`[Pinecone] Se han guardado ${vectorsToUpsert.length} chunks para el documento ${documentId}.`);

        const newDocumentData = { documentId, originalName: req.file.originalname, chunkCount: chunks.length };
        
        const updatedChat = await Chat.findByIdAndUpdate(chatId, {
            $push: { 
                [documentType]: newDocumentData,
                messages: { sender: 'bot', text: `Archivo "${req.file.originalname}" procesado y añadido a '${documentType}'.` }
            }
        }, { new: true, runValidators: true });

        res.status(200).json({ updatedChat, documentId });

    } catch (error) {
        console.error('[BACKEND] Error procesando documento:', error); 
        res.status(500).json({ message: 'Error al procesar el archivo.', details: error.message });
    } finally {
        if (req.file?.path) fs.unlinkSync(req.file.path);
    }
});

app.post('/api/chat', protect, async (req, res) => {
    const { conversationHistory, chatId } = req.body;
    if (!chatId || !Array.isArray(conversationHistory)) {
        return res.status(400).json({ message: 'Datos inválidos.' });
    }

    try {
        const currentChat = await Chat.findById(chatId);
        if (!currentChat) {
            return res.status(404).json({ message: "Chat no encontrado." });
        }

        const userQuery = conversationHistory[conversationHistory.length - 1].parts[0].text;

        // --- SUBPROCESO 1: Intentar cambiar el contexto ---
        const contextWasSwitched = await detectAndHandleContextSwitch(currentChat, userQuery, res);
        if (contextWasSwitched) {
            return; // La respuesta ya fue enviada por el subproceso, así que terminamos.
        }

        // --- SI LLEGAMOS AQUÍ, ES UN CHAT NORMAL DENTRO DEL CONTEXTO ACTUAL ---
        
        // --- SUBPROCESO 2: Obtener documentos del contexto activo ---
        const documentIds = getDocumentsForActiveContext(currentChat);
        
        let contents = conversationHistory.map(msg => ({ role: msg.role, parts: msg.parts }));

        if (documentIds.length > 0) {
            const queryEmbedding = await getEmbedding(userQuery);
            const relevantChunks = await findRelevantChunksAcrossDocuments(queryEmbedding, documentIds);
            
            if (relevantChunks.length > 0) {
                const contextString = `CONTEXTO EXTRAÍDO DE DOCUMENTOS DE "${currentChat.activeContext}":\n---\n` + relevantChunks.join("\n---\n");
                contents.unshift({ role: 'user', parts: [{ text: contextString }] });
            }
        }

        // --- SUBPROCESO 3: Generar respuesta de la IA y guardar en BD ---
        let botText;
        try {
            const chatSession = generativeModel.startChat({ history: contents.slice(0, -1) });
            const result = await chatSession.sendMessage(userQuery);
            botText = result.response.text();
        } catch (geminiError) {
            console.error("Error con la API de Gemini:", geminiError);
            return res.status(504).json({ message: `Error con la IA: ${geminiError.message}` });
        }

        const updatedChat = await Chat.findByIdAndUpdate(chatId, {
            $push: { messages: { $each: [
                { sender: 'user', text: userQuery },
                { sender: 'ai', text: botText }
            ]}}
        }, { new: true });

        res.status(200).json({ updatedChat });

    } catch (mainError) {
        console.error("Error inesperado en el servidor:", mainError);
        res.status(500).json({ message: "Error inesperado en el servidor." });
    }
});

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => console.log(`Servidor backend corriendo en http://localhost:${PORT}`));