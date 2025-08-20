require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
const fs = require('fs');
const multer = require('multer');
const pdf = require('pdf-parse');
const mammoth = require("mammoth");
const { GoogleGenerativeAI } = require("@google/generative-ai");

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

// --- MONTAR RUTAS DE USUARIO ---
app.use('/api/users', userRoutes);

// --- LÓGICA DE RAG Y CONSTANTES ---

const GOOGLE_AI_STUDIO_URL = process.env.GOOGLE_AI_STUDIO_URL;



const GOOGLE_AI_STUDIO_API_KEY = process.env.GOOGLE_AI_STUDIO_API_KEY;
const genAI = new GoogleGenerativeAI(GOOGLE_AI_STUDIO_API_KEY);

// INICIALIZA EL MODELO GENERATIVO AQUÍ, JUNTO AL DE EMBEDDING
const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
const generativeModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); // Usamos este para la extracción

const vectorStore = {};
const upload = multer({ dest: 'uploads/' });


// FUNCIÓN CORREGIDA USANDO EL SDK DE GOOGLE AI
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

const supportedTypes = {
    'application/pdf': 'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
    'application/msword': 'application/msword', // DOC (Word antiguo)
    'application/vnd.oasis.opendocument.text': 'application/vnd.oasis.opendocument.text', // ODT (OpenOffice)
    'text/plain': 'text/plain',
    'text/markdown': 'text/markdown',
    'text/html': 'text/html',
    'text/css': 'text/css',
    'text/javascript': 'application/javascript',
    'application/json': 'application/json',
    'text/xml': 'application/xml',
    'text/csv': 'text/csv',
    'application/rtf': 'application/rtf' // Rich Text Format
};

const extractTextFromFile = async (file) => {
    const filePath = file.path;
    const mimetype = file.mimetype; // La variable correcta
    let text = '';

    // Usamos 'mimetype' en toda la lógica
    if (Object.keys(supportedTypes).includes(mimetype)) {
        const apiMimeType = supportedTypes[mimetype];
        console.log(`Extrayendo texto de ${mimetype} con Gemini (usando ${apiMimeType})...`);
        text = await extractTextWithGemini(filePath, apiMimeType);
    } else {
        // El error de "Tipo de archivo no soportado" ahora funcionará correctamente
        console.error(`Tipo de archivo no soportado: ${mimetype}`);
        throw new Error('Tipo de archivo no soportado.');
    }
    
    return text;
};

const getEmbedding = async (text) => { const result = await embeddingModel.embedContent(text); return result.embedding.values; };
const chunkDocument = (text, chunkSize = 1000, overlap = 200) => { const chunks = []; for (let i = 0; i < text.length; i += chunkSize - overlap) { chunks.push(text.substring(i, i + chunkSize)); } return chunks; };
const cosineSimilarity = (vecA, vecB) => { let dotProduct = 0, magA = 0, magB = 0; for(let i=0;i<vecA.length;i++){ dotProduct += vecA[i]*vecB[i]; magA += vecA[i]*vecA[i]; magB += vecB[i]*vecB[i]; } magA = Math.sqrt(magA); magB = Math.sqrt(magB); if(magA===0||magB===0)return 0; return dotProduct/(magA*magB); };
const findRelevantChunksAcrossDocuments = async (queryEmbedding, documentIds, topK = 5) => {
    if (!documentIds || documentIds.length === 0) return [];

    let allScoredChunks = [];

    for (const docId of documentIds) {
        if (vectorStore[docId]) {
            const scoredChunks = vectorStore[docId].map(chunk => ({
                chunkText: chunk.chunkText,
                similarity: cosineSimilarity(queryEmbedding, chunk.embedding)
            }));
            allScoredChunks.push(...scoredChunks);
        }
    }

    allScoredChunks.sort((a, b) => b.similarity - a.similarity);

    return allScoredChunks.slice(0, topK).map(sc => sc.chunkText);
};

// --- RUTAS DE CHAT (PROTEGIDAS) ---

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

// REEMPLAZA TU app.post('/api/process-document',...) EXISTENTE CON ESTO:

app.post('/api/process-document', protect, upload.single('file'), async (req, res) => {
    if (!req.file || !req.body.chatId) {
        return res.status(400).json({ message: 'Falta archivo o ID del chat.' });
    }
    
    try {
        const text = await extractTextFromFile(req.file);

        if (!text || !text.trim()) {
            throw new Error('No se pudo extraer texto del documento.');
        }
        
        const documentId = `doc_${req.body.chatId}_${Date.now()}`;
        const chunks = chunkDocument(text);
        vectorStore[documentId] = await Promise.all(
            chunks.map(async (chunk) => ({ chunkText: chunk, embedding: await getEmbedding(chunk) }))
        );

        let systemMessageText = `Archivo "${req.file.originalname}" procesado y añadido al contexto del chat.`;
        
        // --- ESTA ES LA PARTE CRÍTICA ---
        // Nos aseguramos de usar $push en el campo correcto: 'documentIds' (en plural)
        const updatedChat = await Chat.findByIdAndUpdate(req.body.chatId, {
            $push: { 
                documentIds: documentId, 
                messages: { sender: 'bot', text: systemMessageText }
            }
        }, { new: true });

        res.status(200).json({ updatedChat, documentId });

    } catch (error) {
        // --- AÑADIMOS UN LOG PARA VER EL ERROR EXACTO EN EL SERVIDOR ---
        console.error('[BACKEND] Error procesando documento:', error); 
        res.status(500).json({ message: 'Error al procesar el archivo.', details: error.message });

    } finally {
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
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
        const documentIds = currentChat.documentIds;
        
        let contents = conversationHistory.map(msg => ({ role: msg.role, parts: msg.parts }));

        if (documentIds && documentIds.length > 0) {
            const userQuery = contents[contents.length - 1].parts[0].text;
            const queryEmbedding = await getEmbedding(userQuery);
            const relevantChunks = await findRelevantChunksAcrossDocuments(queryEmbedding, documentIds);
            
            if (relevantChunks.length > 0) {
                const contextString = "CONTEXTO EXTRAÍDO DE DOCUMENTOS ADJUNTOS:\n---\n" + relevantChunks.join("\n---\n");
                contents.unshift({ role: 'user', parts: [{ text: contextString }] });
            }
        }

        let botText;
        try {
            const apiResponse = await axios.post(GOOGLE_AI_STUDIO_URL, { contents }, {
                headers: { 'x-goog-api-key': GOOGLE_AI_STUDIO_API_KEY, 'Content-Type': 'application/json' },
                timeout: 30000
            });
            if (!apiResponse.data.candidates?.length) throw new Error("La IA no generó una respuesta.");
            botText = apiResponse.data.candidates[0].content.parts[0].text;
        } catch (geminiError) {
            return res.status(504).json({ message: `Error con la IA: ${geminiError.message}` });
        }

        let updatedChat;
        try {
            const userMessage = conversationHistory[conversationHistory.length - 1];
            const updatePayload = { $push: { messages: { $each: [{ sender: 'user', text: userMessage.parts[0].text }, { sender: 'ai', text: botText }] } } };
            if (currentChat.title === 'Nuevo Chat') {
                updatePayload.title = userMessage.parts[0].text.substring(0, 35) + "...";
            }
            updatedChat = await Chat.findByIdAndUpdate(chatId, updatePayload, { new: true });
        } catch (dbError) {
            return res.status(500).json({ message: "Error al guardar la conversación." });
        }
        res.status(200).json({ updatedChat });

    } catch (mainError) {
        res.status(500).json({ message: "Error inesperado en el servidor." });
    }
});

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => console.log(`Servidor backend corriendo en http://localhost:${PORT}`));