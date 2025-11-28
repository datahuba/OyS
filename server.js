require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const fs =require('fs');
const path = require('path');
const multer = require('multer');
const { VertexAI } = require('@google-cloud/vertexai');
const { GoogleAuth } = require('google-auth-library');
const { Pinecone } = require('@pinecone-database/pinecone'); 
const mammoth = require("mammoth");
const xlsx = require('xlsx');
const pdf = require('pdf-parse');
const axios = require('axios');
const FormData = require('form-data');
const Chat = require('./models/Chat'); 
const { protect } = require('./middleware/authMiddleware');
const GlobalDocument = require('./models/GlobalDocuments');
const app = express();
const PORT = process.env.PORT || 5000;

const userRoutes = require('./routes/userRoutes');
const reportRoutes = require('./routes/reportRoutes'); 
const adminRoutes = require('./routes/adminRoutes');
const chatRoutes = require('./routes/chatRoutes');
const documentRoutes = require('./routes/documentRoutes');
const { extractTextFromFile} = require('./utils.js');
// Middlewares globales
const allowedOrigins = [
  'https://oy-s-frontend-git-master-brandon-gonsales-projects.vercel.app',
  'https://oy-s-frontend-git-develop-brandon-gonsales-projects.vercel.app',               
  'http://localhost:3000',
  'http://localhost:3001',
  "https://oy-s-frontend.vercel.app"
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
const vertexAI = new VertexAI({ location: 'us-central1' });
//const vertexEmbeddingModel = vertexAI.getGenerativeModel({ model: "gemini-embedding-001" });
// Modelos de Google AI
const generativeModel = vertexAI.getGenerativeModel({model: 'gemini-2.5-pro',});

//const embeddingModel = vertexAI.getGenerativeModel({model: "embedding-001",});

const genAI_for_embeddings = new GoogleGenerativeAI(process.env.GOOGLE_AI_STUDIO_API_KEY);
const embeddingModel = genAI_for_embeddings.getGenerativeModel({ model: "embedding-001" });

const vertexEmbeddingModel = genAI_for_embeddings.getGenerativeModel({ model: "gemini-embedding-001" });


// Inicializar Pinecone UNO
const pinecone = new Pinecone({apiKey: process.env.PINECONE_API_KEY,});
const pineconeIndex = pinecone.index('chat-rag'); 
console.log("Conectado y listo para usar el índice de Pinecone: 'chat-rag'.");
// Inicializar Pinecone DOS
const pinecone2 = new Pinecone({apiKey: process.env.PINECONE_API_KEY2,});
const pineconeIndex2 = pinecone2.index('rag-normativas-uagrm'); 
console.log("Conectado y listo para usar el índice de Pinecone: 'rag-normativas-uagrm'.");

const CONVERSION_SERVICE_URL = process.env.CONVERSION_SERVICE_URL;

// --- MONTAR RUTAS DE USUARIO ---
app.use('/api/users', userRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/informes', reportRoutes);
app.use('/api/admin', adminRoutes);
// --- LÓGICA DE DETECCIÓN DE CONTEXTO POR EMBEDDINGS ---
const SIMILARITY_THRESHOLD = 0.9;



const upload = multer({ dest: 'uploads/' }).array('files', 10);

// --- SUBPROCESOS Y FUNCIONES AUXILIARES ---



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

// --- FUNCIÓN DE BÚSQUEDA ESPECÍFICA EN EL ÍNDICE DE NORMATIVAS (pineconeIndex2) ---
const findRelevantChunksInNormativas = async (queryEmbedding, topK = 10) => {
    try {
        const queryResponse = await pineconeIndex2.query({
            topK,
            vector: queryEmbedding,
            includeMetadata: true,
        });
        if (queryResponse.matches?.length) {
            return queryResponse.matches.map(match => match.metadata.text);
        }
        return [];
    } catch (error) {
        console.error("[Pinecone - Normativas] Error al realizar la búsqueda:", error);
        return [];
    }
};

// --- FUNCIÓN getEmbedding (VERSIÓN SIMPLE DE AI STUDIO PARA COMPATIBILIDAD) ---
const getEmbedding = async (text) => {
    try {
        const result = await embeddingModel.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        console.error("Error al generar embedding con AI Studio:", error);
        throw new Error("No se pudo generar el embedding de compatibilidad.");
    }
};

const getVertexEmbedding = async (text) => {
    try {
        const result = await vertexEmbeddingModel.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        console.error("Error al generar embedding con AI Studio:", error);
        throw new Error("No se pudo generar el embedding de compatibilidad.");
    }
};

const chunkDocument = (text, chunkSize = 1000, overlap = 200) => { const chunks = []; for (let i = 0; i < text.length; i += chunkSize - overlap) { chunks.push(text.substring(i, i + chunkSize)); } return chunks; };



app.post('/api/process-document', protect, upload, async (req, res) => {
    const { chatId, documentType } = req.body;

    if (!req.files || req.files.length === 0 || !chatId || !documentType) {
        return res.status(400).json({ message: 'Faltan archivos, ID del chat o tipo de documento.' });
    }
    
    const allowedTypes = ['miscellaneous','chat','compatibilizacionFacultades','consolidadoFacultades','compatibilizacionAdministrativo','consolidadoAdministrativo','miscellaneous'];

    if (!allowedTypes.includes(documentType)) {
        return res.status(400).json({ message: 'Tipo de documento inválido.' });
    }
    
    try {
        // <-- 1. OBTENEMOS EL ESTADO DEL CHAT ANTES DEL BUCLE ---
        //    Necesitamos saber si estamos en modo superusuario.
        const currentChat = await Chat.findById(chatId);
        if (!currentChat) {
            return res.status(404).json({ message: "Chat no encontrado." });
        }

        // --- Bucle para procesar cada archivo (esta parte no cambia) ---
        for (const file of req.files) {
            console.log(`Procesando archivo: ${file.originalname}...`);
            const text = await extractTextFromFile(file);
            if (!text || !text.trim()) {
                console.warn(`No se pudo extraer texto del archivo ${file.originalname}, se omitirá.`);
                continue;
            }
            const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
            const documentId = `doc_${chatId}_${Date.now()}_${sanitizedFilename}`;
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

        // --- 2. LÓGICA DE GUARDADO SIMPLIFICADA ---
        console.log(`Guardando ${file.originalname} en el contexto '${documentType}' del chat.`);

        const newDocumentData = { documentId, originalName: file.originalname, chunkCount: chunks.length };
        const systemMessage = { sender: 'bot', text: `Archivo "${file.originalname}" procesado y añadido a '${documentType}'.` };

        await Chat.findByIdAndUpdate(chatId, {
            $push: { 
                [documentType]: newDocumentData,
                messages: systemMessage
            }
        });   } 
        
        // --- 3. RESPUESTA AL FRONTEND ---
        // Después de procesar todos los archivos, buscamos el estado final del chat y lo devolvemos
        const finalChatState = await Chat.findById(chatId);
        res.status(200).json({ updatedChat: finalChatState });

    } catch (error) {
        console.error('[BACKEND] Error procesando múltiples documentos:', error); 
        res.status(500).json({ message: 'Error al procesar los archivos.', details: error.message });
    } finally {
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
    const { conversationHistory, chatId, useGlobalContext = true } = req.body; 

    if (!chatId || !Array.isArray(conversationHistory)) {
        return res.status(400).json({ message: 'Datos inválidos.' });
    }

    try {
        const currentChat = await Chat.findById(chatId);
        if (!currentChat) {
            return res.status(404).json({ message: "Chat no encontrado." });
        }

        const userQuery = conversationHistory[conversationHistory.length - 1].parts[0].text;
        


        // --- LÓGICA DE CHAT NORMAL CON RAG ---
        // 1. Obtener documentos del chat
        const chatDocumentIds = getDocumentsForActiveContext(currentChat);
        let allSearchableIds = [...chatDocumentIds];
        // 2. AÑADIR DOCUMENTOS GLOBALES SÓLO SI EL BOOLEANO ES TRUE
        if (useGlobalContext) {
            console.log("[DEBUG] 'useGlobalContext' es true. Buscando documentos globales...");
            const globalDocs = await GlobalDocument.find({});
            const globalDocumentIds = globalDocs.map(doc => doc.documentId);
            allSearchableIds = [...new Set([...chatDocumentIds, ...globalDocumentIds])];
            } 
        else {
            console.log("[DEBUG] 'useGlobalContext' es false. Omitiendo documentos globales.");
            }
        
        console.log(`[DEBUG] Total de IDs únicos para la búsqueda en Pinecone:`, allSearchableIds);

        
         // Preparamos el historial de conversación original para enviarlo al modelo.
        let contents = conversationHistory.map(msg => ({
            role: msg.role,
            parts: msg.parts
        }));

        if (allSearchableIds.length > 0) {
            const queryEmbedding = await getEmbedding(userQuery);
            const relevantChunks = await findRelevantChunksAcrossDocuments(queryEmbedding, allSearchableIds,20);
            console.log(`[DEBUG] Se encontraron ${relevantChunks.length} chunks relevantes en Pinecone.`);

            if (relevantChunks.length > 0) {
            const contextString = "Contexto relevante de los documentos:\n" + 
                                  "-------------------------------------\n" +
                                  relevantChunks.join("\n---\n") +
                                  "\n-------------------------------------\n" +
                                  "Por favor, basa tu respuesta en la pregunta del usuario y en el contexto proporcionado.";
            contents.unshift({ role: 'user', parts: [{ text: contextString }] });

            }
        }

        let botText;
        try {
            // Usamos `startChat`, que está optimizado para conversaciones.
            // Le pasamos el historial (que ahora incluye el contexto al inicio) MENOS la última pregunta del usuario.
            const chatSession = generativeModel.startChat({ history: contents.slice(0, -1) });

            // Enviamos la pregunta ORIGINAL del usuario como el último mensaje de la sesión.
            const result = await chatSession.sendMessage(userQuery);
                const response = result.response;
                botText = response.candidates[0].content.parts[0].text; 

        } catch (geminiError) {
            console.error("Error con la API de Gemini:", geminiError);
            console.error("Detalles del error de Gemini:", JSON.stringify(geminiError, null, 2));
            return res.status(504).json({ message: `Error con la IA: ${geminiError.message}` });
        }

        //Guardar en Base de Datos y Responder
        const updatedChat = await Chat.findByIdAndUpdate(chatId, {
            $push: { messages: { $each: [
                { sender: 'user', text: userQuery },
                { sender: 'ai', text: botText }
            ]}}
        }, { new: true });

        res.status(200).json({ updatedChat });

    } catch (mainError) {
        console.error("Error inesperado en la ruta /api/chat:", mainError);
        res.status(500).json({ message: "Error inesperado en el servidor." });
    }
});

app.post('/api/chat-normativas', protect, async (req, res) => {
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
        // LOG 1: Verificar la consulta inicial del usuario.
        console.log(`[Normativas Chat] Paso 1: Recibida nueva consulta: "${userQuery}"`);

        // --- LÓGICA DE CHAT CON RAG DE NORMATIVAS ---

        // 1. Generamos el embedding de la pregunta.
        const queryEmbedding = await getVertexEmbedding(userQuery);
        // LOG 2: Confirmar que el embedding se generó.
        console.log('[Normativas Chat] Paso 2: Embedding para la consulta generado exitosamente.');

        // 2. Buscamos chunks relevantes en Pinecone.
        const relevantChunks = await findRelevantChunksInNormativas(queryEmbedding, 15);
        // LOG 3: Confirmar cuántos chunks se encontraron (esto ya lo tenías).
        console.log(`[Normativas Chat] Paso 3: Se encontraron ${relevantChunks.length} chunks relevantes en Pinecone.`);

        // 3. Construimos el contexto para el modelo.
        if (relevantChunks.length > 0) {
            // LOG 4: ¡EL MÁS IMPORTANTE! Imprimir el contenido de los chunks recuperados.
            // Esto te mostrará exactamente qué información está viendo el modelo.
            console.log('[Normativas Chat] Paso 4: === INICIO DE CHUNKS RECUPERADOS ===');
            relevantChunks.forEach((chunk, index) => {
                // Imprimimos los primeros 150 caracteres de cada chunk para no saturar la consola.
                console.log(`--- Chunk ${index + 1} ---\n"${chunk.substring(0, 150)}..."\n`);
            });
            console.log('[Normativas Chat] === FIN DE CHUNKS RECUPERADOS ===');

            const contextString = "--- INICIO DEL CONTEXTO (Normativas UAGRM) ---\n" + relevantChunks.join("\n---\n") + "\n--- FIN DEL CONTEXTO ---";
            
            const userQueryWithContext = `${contextString}\n\nBasándote **estrictamente** en el contexto anterior sobre las normativas de la UAGRM, responde a la siguiente pregunta: ${userQuery}`;
            
            // LOG 5: Imprimir el prompt completo que se enviará al modelo.
            console.log('[Normativas Chat] Paso 5: === INICIO DEL PROMPT FINAL ENVIADO AL MODELO ===');
            // Imprimimos solo una parte para no duplicar toda la info en la consola.
            console.log(userQueryWithContext.substring(0, 500) + '...');
            console.log('[Normativas Chat] === FIN DEL PROMPT FINAL ENVIADO AL MODELO ===');

            conversationHistory[conversationHistory.length - 1].parts[0].text = userQueryWithContext;
        } else {
            console.log('[Normativas Chat] Paso 4 y 5 omitidos: No se encontraron chunks relevantes.');
        }

        // 4. Preparamos y enviamos la petición al modelo generativo.
        const contents = conversationHistory.map(msg => ({ role: msg.role, parts: msg.parts }));
        const request = { contents: contents };
        const result = await generativeModel.generateContent(request);
        const botText = result.response.candidates[0].content.parts[0].text;

        // LOG 6: Imprimir la respuesta exacta que dio el modelo.
        console.log(`[Normativas Chat] Paso 6: Respuesta recibida del modelo generativo: "${botText}"`);

        // 5. Guardamos la conversación en la base de datos.
        const updatedChat = await Chat.findByIdAndUpdate(chatId, {
            $push: { messages: { $each: [{ sender: 'user', text: userQuery }, { sender: 'ai', text: botText }] } }
        }, { new: true });
        
        // LOG 7: Confirmar que el proceso finalizó y se guardó.
        console.log('[Normativas Chat] Paso 7: Conversación guardada en la base de datos exitosamente.');

        res.status(200).json({ updatedChat });

    } catch (mainError) {
        console.error("Error inesperado en la ruta /api/chat-normativas:", mainError);
        res.status(500).json({ message: "Error inesperado en el servidor." });
    }
});

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => console.log(`Servidor backend corriendo en http://localhost:${PORT}`));
