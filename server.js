require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const fs =require('fs');
const multer = require('multer');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pinecone } = require('@pinecone-database/pinecone'); 
const mammoth = require("mammoth");
// Importaciones de nuestro proyecto
const { protect } = require('./middleware/authMiddleware');
const userRoutes = require('./routes/userRoutes');
const Chat = require('./models/Chat');

const app = express();
const PORT = process.env.PORT || 5000;

// Middlewares globales
const allowedOrigins = [
  'https://oy-s-frontend-git-master-brandon-gonsales-projects.vercel.app',
  'https://oy-s-frontend-git-develop-brandon-gonsales-projects.vercel.app',               
  'http://localhost:3000'
];

const corsOptions = {
  origin: function (origin, callback) {
    if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
      callback(null, true);
    } else {
      callback(new Error('No permitido por la política de CORS'));
    }
  },
  credentials: true
};

app.use(cors(corsOptions));
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
const generativeModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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


const upload = multer({ dest: 'uploads/' }).array('files', 10);

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
    'text/plain'
];
const geminiMimeTypeMapper = {};

const extractTextFromFile = async (file) => {
    const filePath = file.path;
    const clientMimeType = file.mimetype;
    let text = '';

    // Lógica para decidir qué herramienta de extracción usar

    // CASO 1: El archivo es un .docx
    if (clientMimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        
        console.log("Archivo DOCX detectado. Usando 'mammoth' para extracción local...");
        try {
            // Usamos mammoth para convertir el .docx a texto plano
            const result = await mammoth.extractRawText({ path: filePath });
            text = result.value;
            if (!text || !text.trim()) {
                throw new Error('Mammoth no pudo extraer texto del archivo .docx.');
            }
        } catch (mammothError) {
            console.error("Error con Mammoth al procesar .docx:", mammothError);
            throw new Error('No se pudo procesar el archivo de Word.');
        }

    // CASO 2: Es un PDF o un archivo de texto plano (soportados por Gemini)
    } else if (clientMimeType === 'application/pdf' || clientMimeType === 'text/plain') {
        
        console.log(`Archivo ${clientMimeType} detectado. Usando Gemini para extracción...`);
        text = await extractTextWithGemini(filePath, clientMimeType);

    // CASO 3: El tipo de archivo no está soportado
    } else {
        console.error(`Tipo de archivo no soportado: ${clientMimeType}`);
        throw new Error('Tipo de archivo no soportado. Por favor, sube un .docx, .pdf o .txt');
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

app.post('/api/process-document', protect, upload, async (req, res) => { // Nota: ya no es upload.single('file')
    const { chatId, documentType } = req.body;

    // Ahora verificamos req.files (plural)
    if (!req.files || req.files.length === 0 || !chatId || !documentType) {
        return res.status(400).json({ message: 'Faltan archivos, ID del chat o tipo de documento.' });
    }
    const allowedTypes = ['compatibilizacion', 'consolidadoFacultades', 'consolidadoAdministrativo', 'miscellaneous'];
    if (!allowedTypes.includes(documentType)) {
        return res.status(400).json({ message: 'Tipo de documento inválido.' });
    }
    
    try {
        let allNewDocumentsData = [];
        let allSystemMessages = [];

        // --- 1. PROCESAMOS CADA ARCHIVO EN UN BUCLE ---
        for (const file of req.files) {
            console.log(`Procesando archivo: ${file.originalname}...`);
            const text = await extractTextFromFile(file);
            if (!text || !text.trim()) {
                console.warn(`No se pudo extraer texto del archivo ${file.originalname}, se omitirá.`);
                continue; // Salta al siguiente archivo si este no tiene texto
            }
            
            const documentId = `doc_${chatId}_${Date.now()}_${file.originalname}`;
            const chunks = chunkDocument(text);
            
            const vectorsToUpsert = await Promise.all(
                chunks.map(async (chunk, index) => ({
                    id: `${documentId}_chunk_${index}`,
                    values: await getEmbedding(chunk),
                    metadata: { documentId, chunkText: chunk },
                }))
            );
            
            await pineconeIndex.upsert(vectorsToUpsert);
            console.log(`[Pinecone] Guardados ${vectorsToUpsert.length} chunks para ${file.originalname}.`);

            // --- 2. RECOPILAMOS LOS METADATOS Y MENSAJES ---
            allNewDocumentsData.push({ documentId, originalName: file.originalname, chunkCount: chunks.length });
            allSystemMessages.push({ sender: 'bot', text: `Archivo "${file.originalname}" procesado y añadido a '${documentType}'.` });
        }
        
        if(allNewDocumentsData.length === 0) {
            throw new Error("Ninguno de los archivos subidos contenía texto extraíble.");
        }

        // --- 3. HACEMOS UNA SOLA ACTUALIZACIÓN EN LA BASE DE DATOS ---
        const updatedChat = await Chat.findByIdAndUpdate(chatId, {
            $push: { 
                // Usamos el operador $each para añadir todos los metadatos y mensajes a la vez
                [documentType]: { $each: allNewDocumentsData },
                messages: { $each: allSystemMessages }
            }
        }, { new: true, runValidators: true });

        res.status(200).json({ updatedChat });

    } catch (error) {
        console.error('[BACKEND] Error procesando múltiples documentos:', error); 
        res.status(500).json({ message: 'Error al procesar los archivos.', details: error.message });
    } finally {
        // Limpiamos todos los archivos temporales subidos
        if (req.files && req.files.length > 0) {
            req.files.forEach(file => {
                if (fs.existsSync(file.path)) {
                    fs.unlinkSync(file.path);
                }
            });
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