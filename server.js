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
const userRoutes = require('./routes/userRoutes');
const GlobalDocument = require('./models/GlobalDocuments');
const app = express();
const PORT = process.env.PORT || 5000;
const reportRoutes = require('./routes/reportRoutes'); 
const { extractTextFromFile, processAndFillForm } = require('./utils.js');
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
const cosineSimilarity = (vecA, vecB) => { let dotProduct = 0, magA = 0, magB = 0; for(let i=0;i<vecA.length;i++){ dotProduct += vecA[i]*vecB[i]; magA += vecA[i]*vecA[i]; magB += vecB[i]*vecB[i]; } magA = Math.sqrt(magA); magB = Math.sqrt(magB); if(magA===0||magB===0)return 0; return dotProduct/(magA*magB); };


// --- RUTAS DE LA API ---
app.post('/api/chats/:chatId/context', protect, async (req, res) => {
    const { chatId } = req.params;
    const { newContext } = req.body;

    // 1. VALIDACIÓN ROBUSTA (de mi versión)
    // Lee la lista de contextos válidos directamente desde el modelo de la base de datos.
    const validContexts = Chat.schema.path('activeContext').enumValues;
    if (!newContext || !validContexts.includes(newContext)) {
        return res.status(400).json({ message: 'Contexto inválido o no proporcionado.' });
    }

    try {
        const chat = await Chat.findById(chatId);
        if (!chat) {
            return res.status(404).json({ message: "Chat no encontrado." });
        }

        if (chat.activeContext === newContext) {
            return res.status(200).json({ 
                message: "El contexto ya era el activo.",
                updatedChat: chat 
            });
        }

        const updatedChat = await Chat.findByIdAndUpdate(chatId, {
            $set: { activeContext: newContext }
        }, { new: true });

        res.status(200).json({ updatedChat });

    } catch (error) {
        console.error("Error al cambiar el contexto explícitamente:", error);
        res.status(500).json({ message: "Error del servidor al cambiar el contexto." });
    }
});



// --- RUTA DE LA API PARA OBTENER TODOS LOS CONTEXTOS DISPONIBLES ---
app.get('/api/contexts', (req, res) => {
    try {
        // Extraemos solo los nombres de los contextos desde la configuración CONTEXT_TRIGGERS
        const availableContexts = CONTEXT_TRIGGERS.map(trigger => trigger.contextName);

        // Respondemos con la lista de contextos en formato JSON
        // Es una buena práctica devolver un objeto en lugar de un array directamente
        res.status(200).json({ contexts: availableContexts });

    } catch (error) {
        console.error("Error al obtener la lista de contextos:", error);
        res.status(500).json({ message: "Error del servidor al recuperar los contextos." });
    }
});


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

app.put('/api/chats/:id/title', protect, async (req, res) => { // <-- El parámetro se llama ':id'
    // --- CAMBIO 1: Usa 'id' en lugar de 'chatId' ---
    const { id } = req.params; 
    const { newTitle } = req.body;

    if (!newTitle || typeof newTitle !== 'string' || newTitle.trim().length === 0) {
        return res.status(400).json({ message: 'Se requiere un nuevo título válido.' });
    }

    // --- CAMBIO 2: Valida 'id' ---
    if (!mongoose.Types.ObjectId.isValid(id)) { 
        return res.status(400).json({ message: 'ID de chat inválido.' });
    }

    try {
        // --- CAMBIO 3: Busca usando 'id' ---
        const chat = await Chat.findOne({ _id: id, userId: req.user._id }); 

        if (!chat) {
            return res.status(404).json({ message: 'Chat no encontrado o no autorizado.' });
        }

        chat.title = newTitle.trim();
        await chat.save();

        res.status(200).json({ message: 'Título actualizado exitosamente.', updatedChat: chat });

    } catch (error) {
        console.error("Error al actualizar el título del chat:", error);
        res.status(500).json({ message: "Error del servidor al actualizar el título." });
    }
});

app.post('/api/process-document', protect, upload, async (req, res) => {
    const { chatId, documentType } = req.body;

    if (!req.files || req.files.length === 0 || !chatId || !documentType) {
        return res.status(400).json({ message: 'Faltan archivos, ID del chat o tipo de documento.' });
    }
    
    const allowedTypes = [
    'miscellaneous',
    'chat',
    'compatibilizacionFacultades', 
    'consolidadoFacultades', 
    'compatibilizacionAdministrativo', 
    'consolidadoAdministrativo',
    'miscellaneous'
    ];

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

            // --- 2. LÓGICA DE GUARDADO INTELIGENTE (LA MODIFICACIÓN PRINCIPAL) ---
            if (currentChat.isSuperuserMode) {
                // MODO SUPERUSUARIO: Guardamos en la colección global
                console.log(`Modo Superusuario: Guardando ${file.originalname} en la base de conocimiento global.`);
                await GlobalDocument.create({
                    documentId,
                    originalName: file.originalname,
                    chunkCount: chunks.length,
                    uploadedBy: req.user._id // Guardamos qué admin subió el archivo
                });
                
                // (Opcional) Podemos añadir un mensaje de confirmación al chat actual
                await Chat.findByIdAndUpdate(chatId, {
                    $push: { messages: { sender: 'bot', text: `Archivo "${file.originalname}" añadido a la base de conocimiento GLOBAL.` }}
                });

            } else {
                // MODO NORMAL: Guardamos en el chat actual, como antes
                console.log(`Modo Normal: Guardando ${file.originalname} en el contexto '${documentType}' del chat.`);
                const newDocumentData = { documentId, originalName: file.originalname, chunkCount: chunks.length };
                const systemMessage = { sender: 'bot', text: `Archivo "${file.originalname}" procesado y añadido a '${documentType}'.` };
                
                await Chat.findByIdAndUpdate(chatId, {
                    $push: { 
                        [documentType]: newDocumentData,
                        messages: systemMessage
                    }
                }, { runValidators: true });
            }
        }
        
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
        
        // --- ¡NUEVO BLOQUE DE CÓDIGO PARA COMANDOS DE DEBUG! ---
        if (userQuery === process.env.DEBUG_SECRET_ON) {
            const updatedChat = await Chat.findByIdAndUpdate(chatId, { 
                debugMode: true,
                $push: { messages: { sender: 'bot', text: 'Modo DEBUG de JSON activado para este chat.' }}
            }, { new: true });
            return res.status(200).json({ updatedChat });
        }
        if (userQuery === process.env.DEBUG_SECRET_OFF) {
            const updatedChat = await Chat.findByIdAndUpdate(chatId, { 
                debugMode: false,
                $push: { messages: { sender: 'bot', text: 'Modo DEBUG de JSON desactivado.' }}
            }, { new: true });
            return res.status(200).json({ updatedChat });
        }
        // --- FIN DEL NUEVO BLOQUE ---

        // --- MANEJO DE COMANDOS DE SUPERUSUARIO ---
        if (userQuery === process.env.SUPERUSER_SECRET && !currentChat.isSuperuserMode) {
            const updatedChat = await Chat.findByIdAndUpdate(chatId, { 
                isSuperuserMode: true,
                $push: { messages: { sender: 'bot', text: 'Modo Superusuario ACTIVADO.' }}
            }, { new: true });
            return res.status(200).json({ updatedChat });
        }
        if (userQuery === "exit" && currentChat.isSuperuserMode) {
            const updatedChat = await Chat.findByIdAndUpdate(chatId, { 
                isSuperuserMode: false,
                $push: { messages: { sender: 'bot', text: 'Modo Superusuario DESACTIVADO.' }}
            }, { new: true });
            return res.status(200).json({ updatedChat });
        }

        // --- LÓGICA DE CHAT NORMAL CON RAG ---
        // 1. Obtener documentos relevantes (del chat y globales)
        const documentIds = getDocumentsForActiveContext(currentChat);
        //console.log(`[DEBUG] Documentos del contexto activo ('${currentChat.activeContext}'):`, documentIds);
        const globalDocs = await GlobalDocument.find({});
        const globalDocumentIds = globalDocs.map(doc => doc.documentId);
        //console.log(`[DEBUG] Documentos Globales encontrados en la BD (${globalDocumentIds.length}):`, globalDocumentIds);
        const allSearchableIds = [...new Set([...documentIds, ...globalDocumentIds])];
        //console.log(`[DEBUG] Total de IDs únicos para la búsqueda en Pinecone:`, allSearchableIds);

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

app.post('/api/extract-json', protect, upload, async (req, res) => {
    // 1. Obtenemos los datos del body, como los envía el frontend
    const { formType, chatId } = req.body;

    // --- Validaciones (igual que antes) ---
    if (!mongoose.Types.ObjectId.isValid(chatId)) {
        return res.status(400).json({ message: 'ID de Chat inválido.' });
    }
    // ... resto de tus validaciones ...
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: 'No se han subido archivos.' });
    }
     if (req.files.length > 1) {
        return res.status(400).json({ message: 'Por favor, sube solo un archivo a la vez.' });
    }
    if (!formType || !['form1', 'form2', 'form3'].includes(formType)) {
        return res.status(400).json({ message: 'Tipo de formulario inválido.' });
    }

    const file = req.files[0];

    try {
        console.log(`[API] Extrayendo JSON de ${file.originalname} para el Chat ID: ${chatId}`);
        
        // 1. Extraemos el JSON (esto no cambia)
        const filledJson = await processAndFillForm(file, formType, generativeModel);

        // 2. Lógica de Guardado en MongoDB
        // Creamos el nombre del campo dinámicamente (ej. 'formulario1Data')
        const updateField = `formulario${formType.slice(-1)}Data`; 

        const updatedChat = await Chat.findByIdAndUpdate(
            chatId,
            {
                // Usamos $set para establecer o reemplazar el contenido del campo
                $set: { [updateField]: filledJson }, 
                // También añadimos un mensaje de confirmación al chat
                $push: {
                    messages: {
                        sender: 'bot',
                        text: `Datos de "${file.originalname}" (${formType}) procesados y guardados en la base de datos.`
                    }
                }
            },
            { new: true } // Para que nos devuelva el documento ya actualizado
        );

        if (!updatedChat) {
            return res.status(404).json({ message: "No se encontró el Chat para actualizar." });
        }

        // 3. Devolvemos la respuesta que el frontend espera
        res.status(200).json({ updatedChat: updatedChat });

    } catch (error) {
        console.error(`[API] Error en la ruta /api/extract-json:`, error);
        res.status(500).json({ message: 'Error en el servidor durante la extracción del JSON.', error: error.message });
    } finally {
        // El 'finally' se mantiene para borrar el archivo temporal de /uploads
        if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }
    }
});

app.use('/api/users', userRoutes);
app.use('/api/informes', reportRoutes);

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => console.log(`Servidor backend corriendo en http://localhost:${PORT}`));
