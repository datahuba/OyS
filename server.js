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
const GlobalDocument = require('./models/GlobalDocuments');
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

const COMPATIBILIZATION_AUDIT_PROMPT = process.env.COMPATIBILIZATION_AUDIT_PROMPT;

// --- MONTAR RUTAS DE USUARIO ---
app.use('/api/users', userRoutes);

// --- LÓGICA DE DETECCIÓN DE CONTEXTO POR EMBEDDINGS ---
const SIMILARITY_THRESHOLD = 0.9;
const CONTEXT_TRIGGERS = [
    {
        contextName: 'compatibilizacionFacultades',
        triggerPhrase: 'compatibilizacion de facultades',
        responseMessage: 'Hola, soy tu agente especialista en Compatibilización de Facultades. ¿Cómo puedo ayudarte hoy?',
        promptEnvVar: 'PROMPT_COMPATIBILIZACION_FACULTADES' // <-- NUEVO
    },
    {
        contextName: 'consolidadoFacultades',
        triggerPhrase: 'consolidado de facultades',
        responseMessage: 'Hola, soy tu agente especialista en Consolidado de Facultades. ¿Cómo puedo ayudarte hoy',
        promptEnvVar: 'PROMPT_CONSOLIDADO_FACULTADES' // <-- NUEVO
    },
    {
        contextName: 'compatibilizacionAdministrativo',
        triggerPhrase: 'compatibilizacion administrativo',
        responseMessage: 'Hola, soy tu agente especialista en Compatibilización Administrativa. ¿Cómo puedo ayudarte hoy',
        promptEnvVar: 'PROMPT_COMPATIBILIZACION_ADMINISTRATIVO' // <-- NUEVO
    },
    {
        contextName: 'consolidadoAdministrativo',
        triggerPhrase: 'consolidado administrativo',
        responseMessage: 'Hola, soy tu agente especialista en Consolidado Administrativo. ¿Cómo puedo ayudarte hoy',
        promptEnvVar: 'PROMPT_CONSOLIDADO_ADMINISTRATIVO' // <-- NUEVO
    },
    {
        contextName: 'miscellaneous', // Este no tiene tarea especial
        triggerPhrase: 'volver a chat',
        responseMessage: 'Bienvenido de vuelta. Soy un modelo de Inteligencia Artificial entrenado para asistirte en tus tareas. ¿Qué quieres hacer hoy?'
        // Sin promptEnvVar
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

async function handleSpecializedAgentTask(chat, userQuery, res) {
    const activeContextName = chat.activeContext;
    console.log(`✅ Tarea Especializada del Agente [${activeContextName}] iniciada para el chat [${chat._id}]`);
    
    try {
        // 1. OBTENER EL PROMPT CORRECTO DESDE LA CONFIGURACIÓN
        const triggerConfig = CONTEXT_TRIGGERS.find(t => t.contextName === activeContextName);
        const agentPrompt = process.env[triggerConfig.promptEnvVar];

        if (!agentPrompt) {
            throw new Error(`El prompt para el agente '${activeContextName}' no está configurado en .env.`);
        }

        // 2. OBTENER LOS DOCUMENTOS CORRECTOS: los del contexto activo + los globales
        const agentDocumentIds = getDocumentsForActiveContext(chat);
        const globalDocs = await GlobalDocument.find({});
        const globalDocumentIds = globalDocs.map(doc => doc.documentId);
        const relevantDocumentIds = [...agentDocumentIds, ...globalDocumentIds];

        let contextString = "No se encontró contexto relevante en los documentos.";
        if (relevantDocumentIds.length > 0) {
            const queryEmbedding = await getEmbedding(userQuery);
            const relevantChunks = await findRelevantChunksAcrossDocuments(queryEmbedding, relevantDocumentIds, 50);
            
            if (relevantChunks.length > 0) {
                contextString = "--- INICIO DEL CONTEXTO EXTRAÍDO DE DOCUMENTOS ---\n" + relevantChunks.join("\n---\n") + "\n--- FIN DEL CONTEXTO ---";
            }
        }

        // 3. CONSTRUIR EL PROMPT FINAL Y LLAMAR A LA IA
        const finalPrompt = `${agentPrompt}\n\n${contextString}\n\nBasado en lo anterior, responde a la siguiente petición del usuario: "${userQuery}"`;
        
        const chatSession = generativeModel.startChat();
        const result = await chatSession.sendMessage(finalPrompt);
        const botText = result.response.text();

        // 4. GUARDAR Y RESPONDER
        const updatedChat = await Chat.findByIdAndUpdate(chat._id, {
            $push: { messages: { $each: [
                { sender: 'user', text: userQuery },
                { sender: 'ai', text: botText }
            ]}}
        }, { new: true });

        res.status(200).json({ updatedChat });

    } catch (error) {
        console.error(`Error durante la tarea del agente [${activeContextName}]:`, error);
        res.status(500).json({ message: `Ocurrió un error al ejecutar la tarea del agente.` });
    }
}

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
app.post('/api/chats/:chatId/context', protect, async (req, res) => {
    const { chatId } = req.params;
    const { newContext } = req.body;

    // Validamos que el contexto enviado sea válido
    const validContexts = CONTEXT_TRIGGERS.map(t => t.contextName);
    if (!newContext || !validContexts.includes(newContext)) {
        return res.status(400).json({ message: 'Contexto inválido o no proporcionado.' });
    }

    try {
        const chat = await Chat.findById(chatId);
        if (!chat) {
            return res.status(404).json({ message: "Chat no encontrado." });
        }

        // Si el contexto ya es el actual, no hacemos nada para evitar mensajes duplicados
        if (chat.activeContext === newContext) {
            return res.status(200).json({ updatedChat: chat });
        }

        // Buscamos el mensaje de confirmación en nuestra configuración
        const trigger = CONTEXT_TRIGGERS.find(t => t.contextName === newContext);
        const botMessage = trigger ? trigger.responseMessage : `Contexto cambiado a ${newContext}.`;

        const updatedChat = await Chat.findByIdAndUpdate(chatId, {
            activeContext: newContext,
            $push: { messages: { sender: 'bot', text: botMessage } }
        }, { new: true });

        res.status(200).json({ updatedChat });

    } catch (error) {
        console.error("Error al cambiar el contexto explícitamente:", error);
        res.status(500).json({ message: "Error del servidor al cambiar el contexto." });
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

        // --- NUEVO: LÓGICA DE COMANDOS DE SUPERUSUARIO ---
       if (userQuery === process.env.SUPERUSER_SECRET && !currentChat.isSuperuserMode) {
        const updatedChat = await Chat.findByIdAndUpdate(chatId, { 
        isSuperuserMode: true,
        $push: { messages: { sender: 'bot', text: 'Modo Superusuario ACTIVADO. Los próximos documentos se subirán a la base de conocimiento global.' }}
        }, { new: true });
        res.status(200).json({ updatedChat });
        return;
        }
        if (userQuery === "exit" && currentChat.isSuperuserMode) {
        const updatedChat = await Chat.findByIdAndUpdate(chatId, { 
            isSuperuserMode: false,
            $push: { messages: { sender: 'bot', text: 'Modo Superusuario DESACTIVADO. Volviendo al funcionamiento normal del chat.' }}
        }, { new: true });
        res.status(200).json({ updatedChat });
        return;
        }

        // --- DISPARADOR GENÉRICO PARA TAREAS DE AGENTES ESPECIALIZADOS ---
        const activeContextName = currentChat.activeContext;
        const activeTrigger = CONTEXT_TRIGGERS.find(t => t.contextName === activeContextName);

        // Comprobamos si el contexto activo TIENE una tarea especial (no es 'miscellaneous')
        if (activeTrigger && activeTrigger.promptEnvVar) {
            const userQueryEmbedding = await getEmbedding(userQuery);
            const agentTriggerEmbedding = triggerEmbeddings[activeContextName].embedding;
            const similarity = cosineSimilarity(userQueryEmbedding, agentTriggerEmbedding);

            // Si la intención es OTRA VEZ la del agente activo, activamos la tarea especial
            if (similarity > SIMILARITY_THRESHOLD) {
                await handleSpecializedAgentTask(currentChat, userQuery, res); // Llamamos a la nueva función genérica
                return; // Termina la ejecución aquí
            }
        }

        // --- SUBPROCESO 1: Intentar cambiar el contexto ---
        const contextWasSwitched = await detectAndHandleContextSwitch(currentChat, userQuery, res);
        if (contextWasSwitched) {
            return; // La respuesta ya fue enviada por el subproceso, así que terminamos.
        }

        // --- SI LLEGAMOS AQUÍ, ES UN CHAT NORMAL DENTRO DEL CONTEXTO ACTUAL ---
        
        // --- SUBPROCESO 2: Obtener documentos del contexto activo ---
        const documentIds = getDocumentsForActiveContext(currentChat);
        
        const globalDocs = await GlobalDocument.find({});
        const globalDocumentIds = globalDocs.map(doc => doc.documentId);
        const allSearchableIds = [...documentIds, ...globalDocumentIds];

        let contents = conversationHistory.map(msg => ({ role: msg.role, parts: msg.parts }));

        if (allSearchableIds.length > 0) {
            const queryEmbedding = await getEmbedding(userQuery);
            const relevantChunks = await findRelevantChunksAcrossDocuments(queryEmbedding, allSearchableIds);
            
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