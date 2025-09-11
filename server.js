require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const fs =require('fs');
const path = require('path');
const multer = require('multer');
const { GoogleGenerativeAI } = require("@google/generative-ai");
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

// Middlewares globales
const allowedOrigins = [
  'https://oy-s-frontend-git-master-brandon-gonsales-projects.vercel.app',
  'https://oy-s-frontend-git-develop-brandon-gonsales-projects.vercel.app',               
  'http://localhost:3000',
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

// Modelos de Google AI
const GOOGLE_AI_STUDIO_API_KEY = process.env.GOOGLE_AI_STUDIO_API_KEY;
const genAI = new GoogleGenerativeAI(GOOGLE_AI_STUDIO_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: "embedding-001" });
const generativeModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
const visionGenerativeModel = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

// <-- CORRECCIÓN: Inicializar Pinecone
const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY,
});
const pineconeIndex = pinecone.index('chat-rag'); 
console.log("Conectado y listo para usar el índice de Pinecone: 'chat-rag'.");

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



// Función para extraer texto de PDFs con Gemini (nuestro fallback)
async function extractTextWithGemini(filePath, mimetype) {
    console.log("Fallback: Intentando extracción de PDF con Gemini Vision...");
    const fileBuffer = fs.readFileSync(filePath);
    const filePart = { inlineData: { data: fileBuffer.toString("base64"), mimeType: mimetype } };
    const prompt = "Extrae todo el texto de este documento. Devuelve únicamente el texto plano, sin ningún formato adicional, como si lo copiaras y pegaras. No resumas nada.";
    try {
        const result = await visionGenerativeModel.generateContent([prompt, filePart]);
        return result.response.text();
    } catch (error) {
        console.error('Error detallado de la API de Gemini:', error); 
        throw new Error('La API de Gemini no pudo procesar el archivo.');
    }
}

// --- NUEVO: Función para describir imágenes con Gemini ---
async function describeImageWithGemini(filePath, mimetype, originalName) {
    console.log("Procesando imagen con Gemini Vision...");
    const fileBuffer = fs.readFileSync(filePath);
    const filePart = { inlineData: { data: fileBuffer.toString("base64"), mimeType: mimetype } };
    const prompt = "Describe detalladamente esta imagen. Si contiene texto, transcríbelo. Si es un diagrama, explica lo que representa. Si es una foto, describe la escena y los objetos.";
    try {
        const result = await visionGenerativeModel.generateContent([prompt, filePart]);
        return `Descripción de la imagen "${originalName}":\n${result.response.text()}`;
    } catch (error) {
        console.error('Error detallado de la API de Gemini Vision:', error);
        throw new Error('La API de Gemini no pudo procesar la imagen.');
    }
}

//---------------------------------------------------------------------------------------
// En server.js, junto a tus otras funciones como getEmbedding, etc.

async function generateAndSaveReport(chatId) {
    try {
        const chat = await Chat.findById(chatId);
        if (!chat) throw new Error("Chat no encontrado para la generación del informe.");

        const documentos = chat.consolidadoFacultades || [];
        const findJsonPath = (formType) => {
            const doc = documentos.find(d => d.metadata?.formType === formType);
            return doc ? doc.metadata.jsonPath : null;
        };

        const pathForm1 = findJsonPath('form1');
        const pathForm2 = findJsonPath('form2');
        const pathForm3 = findJsonPath('form3');

        // ========================================================================
        // --- 1. VALIDACIÓN MODIFICADA ---
        // Ahora, solo lanzamos un error si NO se encuentra NINGÚN archivo de formulario.
        // ========================================================================
        if (!pathForm1 && !pathForm2 && !pathForm3) {
            throw new Error('No se ha subido ningún archivo de formulario para analizar.');
        }

        // ========================================================================
        // --- 2. LECTURA DE ARCHIVOS MODIFICADA ---
        // Leemos los archivos de forma condicional. Si una ruta es null, el resultado será null.
        // Usamos Promise.resolve(null) para que Promise.all no falle con rutas nulas.
        // ========================================================================
        const [jsonForm1, jsonForm2, jsonForm3] = await Promise.all([
            pathForm1 ? fs.promises.readFile(pathForm1, 'utf8') : Promise.resolve(null),
            pathForm2 ? fs.promises.readFile(pathForm2, 'utf8') : Promise.resolve(null),
            pathForm3 ? fs.promises.readFile(pathForm3, 'utf8') : Promise.resolve(null)
        ]);
        console.log(pathForm1);
        // 3. Construir el Mega-Prompt
        let promptTemplate = process.env.PROMPT_GENERAR_INFORME;
        
        // Obtenemos el nombre de la unidad de forma segura, solo si el form1 existe.
        const nombreUnidad = jsonForm1 ? (JSON.parse(jsonForm1)?.analisisOrganizacional?.nombreUnidad || 'Unidad No Especificada') : 'Unidad No Especificada';
        const mesAnio = new Date().toLocaleString('es-ES', { month: 'long', year: 'numeric' });

        // ========================================================================
        // --- 4. CONSTRUCCIÓN DE PROMPT MODIFICADA ---
        // Si un JSON es nulo, lo reemplazamos con un texto claro que indica que no fue proporcionado.
        // Esto le enseña a la IA a manejar la ausencia de datos.
        // ========================================================================
        let finalPrompt = promptTemplate
            .replace('__NOMBRE_UNIDAD__', nombreUnidad)
            .replace('__MES_ANIO__', mesAnio.charAt(0).toUpperCase() + mesAnio.slice(1))
            .replace('__JSON_FORM_1__', jsonForm1 || '"No proporcionado."')
            .replace('__JSON_FORM_2__', jsonForm2 || '"No proporcionado."')
            .replace('__JSON_FORM_3__', jsonForm3 || '"No proporcionado."');

        // El resto de la función (llamada a la IA y guardado) no cambia.
        
        const result = await generativeModel.generateContent(finalPrompt);
        const generatedReportText = result.response.text();

        await Chat.findByIdAndUpdate(chatId, {
            $set: { informeFinal: generatedReportText },
            $push: { messages: { sender: 'ai', text: generatedReportText } }
        });
        
        console.log(`[Report Gen] Informe (parcial o completo) generado y guardado para el Chat ID: ${chatId}`);

    } catch (error) {
        console.error('[Report Gen Background] Error:', error.message);
        await Chat.findByIdAndUpdate(chatId, {
            $push: { messages: { sender: 'bot', text: `Ocurrió un error al generar el informe: ${error.message}` } }
        });
    }
}
//---------------------------------------------------------------------------------------
const extractTextFromFile = async (file) => {
    const filePath = file.path;
    const clientMimeType = file.mimetype;
    const fileExt = path.extname(file.originalname).toLowerCase();
    let text = '';

    // CASO 1: DOCX (mammoth)
    if (fileExt === '.docx'){
        console.log(`Procesando localmente (DOCX): ${file.originalname}`);
        const result = await mammoth.extractRawText({ path: filePath });
        text = result.value;
    }
    // CASO 2: XLSX (xlsx)
    else if (fileExt === '.xlsx'|| fileExt === '.xls') {
        console.log(`Procesando localmente (XLSX): ${file.originalname}`);
        const workbook = xlsx.readFile(filePath);
        const fullText = [];
        workbook.SheetNames.forEach(sheetName => {
            const worksheet = workbook.Sheets[sheetName];
            const sheetText = xlsx.utils.sheet_to_txt(worksheet);
            if (sheetText) fullText.push(`Contenido de la hoja "${sheetName}":\n${sheetText}`);
        });
        text = fullText.join('\n\n---\n\n');
    }
    // CASO 3: PDF (pdf-parse con fallback a Gemini)
    else if (fileExt === '.pdf') {
        console.log(`Procesando localmente (PDF): ${file.originalname}`);
        try {
            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdf(dataBuffer);
            text = data.text;
            if (!text || !text.trim()) throw new Error("pdf-parse no extrajo texto.");
        } catch (error) {
            console.warn("pdf-parse falló. Usando fallback de Gemini...");
            text = await extractTextWithGemini(filePath, clientMimeType);
        }
    }
    // CASO 4: PPTX y VSDX (Delegar al microservicio)
    else if (fileExt === '.pptx' || fileExt === '.vsdx'|| fileExt === '.ppt' || fileExt === '.vsd'|| fileExt === '.doc' || fileExt === '.vsd') {
        if (!CONVERSION_SERVICE_URL) throw new Error('El servicio de conversión no está configurado.');
        try {
            console.log(`Delegando (${fileExt.toUpperCase()}) ${file.originalname} al servicio de conversión...`);
            const form = new FormData();
            form.append('file', fs.createReadStream(filePath), file.originalname);
            const response = await axios.post(CONVERSION_SERVICE_URL, form, {
                headers: form.getHeaders(),
                responseType: 'arraybuffer'
            });
            console.log('PDF recibido del servicio. Extrayendo texto...');
            const data = await pdf(response.data);
            text = data.text;
        } catch (error) {
            console.error("Error con el servicio de conversión:", error.message);
            throw new Error('La conversión remota del archivo falló.');
        }
    }
    // CASO 5: IMÁGENES
    else if (['.jpg', '.jpeg', '.png', '.webp'].includes(fileExt) || clientMimeType.startsWith('image/')) {
        console.log(`Procesando (Imagen): ${file.originalname}`);
        text = await describeImageWithGemini(filePath, clientMimeType, file.originalname);
    }
    // CASO 6: TXT
    else if (fileExt === '.txt' || clientMimeType === 'text/plain') {
        console.log(`Procesando localmente (TXT): ${file.originalname}`);
        text = fs.readFileSync(filePath, 'utf-8');
    }
    // CASO 7: Archivo no soportado
    else {
        throw new Error(`Tipo de archivo no soportado: ${fileExt} (${clientMimeType})`);
    }

    if (!text || !text.trim()) {
        throw new Error('No se pudo extraer o generar contenido de texto del archivo.');
    }
    return text;
};

const processAndFillForm = async (file, formType) => {
  console.log(`[JSON Extractor] Iniciando para el formulario tipo: ${formType}`);

  try {
    const textContent = await extractTextFromFile(file);
    if (!textContent || !textContent.trim()) {
      throw new Error("No se pudo extraer contenido del archivo o está vacío.");
    }

    // Cargar el prompt
    const promptKey = `GEMINI_PROMPT_${formType.toUpperCase()}`;
    console.log(promptKey);
    // Cargar esquema JSON
    const schemaPath = path.join(__dirname, 'schemas', `${formType}.schema.json`);
    const [promptTemplate, schemaFileContent] = await Promise.all([process.env[promptKey],fs.promises.readFile(schemaPath, 'utf8')]);
        if (!promptTemplate) {
        throw new Error(`El prompt para ${formType} no se encontró en el archivo .env`);
    }

    // Armar promp con pedazos
    let finalPrompt = promptTemplate.replace('__JSON_SCHEMA__', schemaFileContent);
    finalPrompt = finalPrompt.replace('__TEXT_TO_PROCESS__', textContent);

    // API
    console.log(`[JSON Extractor] Enviando prompt para ${formType} a la API...`);
    const extractionModel = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
    const result = await extractionModel.generateContent(finalPrompt);
    const responseText = result.response.text();

    // Limpiar respuesta
    const cleanedText = responseText.replace(/^```json\n?/, '').replace(/```$/, '');
    
    try {
      const jsonData = JSON.parse(cleanedText);
      console.log(`[JSON Extractor] ¡JSON para ${formType} parseado con éxito!`);
      return jsonData;
    } catch (parseError) {
      console.error("[JSON Extractor] Error fatal: La respuesta de la IA no es un JSON válido.", parseError);
      console.log("[JSON Extractor] Respuesta recibida de la IA:", cleanedText);
      throw new Error("La respuesta de la IA no pudo ser parseada como JSON.");
    }

  } catch (error) {
    console.error(`[JSON Extractor] Error durante el procesamiento del ${formType}:`, error.message);
    throw error; 
  }
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

        // --- GATILLO PARA GENERAR INFORME ---
        if (userQuery.toLowerCase() === 'generar informe') {
            const userMessage = { sender: 'user', text: userQuery };
            const botMessage = { sender: 'bot', text: 'Entendido. Generando el informe de compatibilización. Esto puede tardar un momento...' };
            
            // Damos feedback inmediato al usuario
            await Chat.findByIdAndUpdate(chatId, {
                $push: { messages: { $each: [userMessage, botMessage] } }
            });

            // Ejecutamos la generación en segundo plano
            generateAndSaveReport(chatId);

            const chatForFeedback = await Chat.findById(chatId);
            return res.status(200).json({ updatedChat: chatForFeedback });
        }

        // --- LÓGICA DE CHAT NORMAL CON RAG ---
        // 1. Obtener documentos relevantes (del chat y globales)
        const documentIds = getDocumentsForActiveContext(currentChat);
        const globalDocs = await GlobalDocument.find({});
        const globalDocumentIds = globalDocs.map(doc => doc.documentId);
        const allSearchableIds = [...documentIds, ...globalDocumentIds];

        let contents = conversationHistory.map(msg => ({ role: msg.role, parts: msg.parts }));

        if (allSearchableIds.length > 0) {
            const queryEmbedding = await getEmbedding(userQuery);
            const relevantChunks = await findRelevantChunksAcrossDocuments(queryEmbedding, allSearchableIds);
            
            if (relevantChunks.length > 0) {
                const contextString = `CONTEXTO EXTRAÍDO DE DOCUMENTOS:\n---\n` + relevantChunks.join("\n---\n");
                contents.unshift({ role: 'user', parts: [{ text: contextString }] });
            }
        }

        // 2. Generar respuesta y guardar en BD
        const chatSession = generativeModel.startChat({ history: contents.slice(0, -1) });
        const result = await chatSession.sendMessage(userQuery);
        const botText = result.response.text();

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
        
        // 2. Extraemos el JSON (esto no cambia)
        const filledJson = await processAndFillForm(file, formType);

        // --- 3. Lógica de Guardado (EL GRAN CAMBIO) ---

        // a) Creamos un nombre de archivo único para el JSON de salida
        const outputFilename = `analisis_${chatId}_${formType}_${Date.now()}.json`;
        const outputPath = path.join(__dirname, 'json_outputs', outputFilename);

        // b) Guardamos el objeto JSON como un archivo en el servidor
        await fs.promises.writeFile(outputPath, JSON.stringify(filledJson, null, 2));
        console.log(`[Storage] JSON extraído guardado en: ${outputPath}`);

        // c) Creamos el objeto de metadatos para guardar en MongoDB
        const jsonDocumentMetadata = {
            // Usamos un 'documentId' especial para diferenciarlo de los de Pinecone
            documentId: `json_output_${outputFilename}`, 
            originalName: file.originalname,
            // Guardamos metadatos adicionales que serán útiles
            metadata: {
                formType: formType,
                jsonPath: outputPath // La ruta donde está el archivo JSON
            },
            chunkCount: 1 // Un archivo JSON es una sola "unidad"
        };
        
        // d) Encontramos el chat y añadimos estos metadatos al array del contexto activo
        const chat = await Chat.findById(chatId);
        if (!chat) {
            return res.status(404).json({ message: "No se encontró el Chat para actualizar." });
        }
        
        // El frontend nos dice que esta tarea es parte de 'consolidadoFacultades'
        const activeContextKey = 'consolidadoFacultades'; 
        
        const updatedChat = await Chat.findByIdAndUpdate(
            chatId,
            { 
                $push: { 
                    [activeContextKey]: jsonDocumentMetadata,
                    messages: {
                        sender: 'bot',
                        text: `Archivo de formulario "${file.originalname}" procesado y sus datos estructurados han sido guardados.`
                    }
                } 
            },
            { new: true }
        );

        // 4. Devolvemos la respuesta EXACTA que el frontend espera
        res.status(200).json({ updatedChat: updatedChat });

    } catch (error) {
        console.error(`[API] Error en la ruta /api/extract-json:`, error);
        res.status(500).json({ message: 'Error en el servidor durante la extracción del JSON.', error: error.message });
    } finally {
        // Limpiamos el archivo TEMPORAL de la carpeta /uploads
        if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }
    }
});

// En server.js, después de la ruta /api/extract-json

// ========================================================================
// --- RUTA PARA GENERAR EL INFORME DE COMPATIBILIZACIÓN ---
// ========================================================================
app.post('/api/generate-report', protect, async (req, res) => {
    // El frontend enviará el ID del chat en el que se está trabajando
    const { chatId } = req.body;

    if (!chatId || !mongoose.Types.ObjectId.isValid(chatId)) {
        return res.status(400).json({ message: 'Se requiere un ID de chat válido.' });
    }

    try {
        console.log(`[Report Gen] Iniciando generación de informe para el Chat ID: ${chatId}`);
        const chat = await Chat.findById(chatId);

        if (!chat) {
            return res.status(404).json({ message: 'Chat no encontrado.' });
        }

        // 1. Encontrar las rutas a los archivos JSON que hemos guardado previamente.
        // Asumimos que los JSON se guardan en el contexto 'consolidadoFacultades'.
        const documentos = chat.consolidadoFacultades || [];
        
        const findJsonPath = (formType) => {
            const doc = documentos.find(d => d.metadata?.formType === formType);
            // La ruta guardada es absoluta en el servidor de Render, así que es segura de usar.
            return doc ? doc.metadata.jsonPath : null;
        };

        const pathForm1 = findJsonPath('form1');
        const pathForm2 = findJsonPath('form2');
        const pathForm3 = findJsonPath('form3');

        if (!pathForm1 || !pathForm2 || !pathForm3) {
            return res.status(400).json({ message: 'Faltan uno o más archivos de formulario procesados en este chat para generar el informe.' });
        }

        // 2. Leer el contenido de los archivos JSON desde el disco del servidor.
        const [jsonForm1, jsonForm2, jsonForm3] = await Promise.all([
            fs.promises.readFile(pathForm1, 'utf8'),
            fs.promises.readFile(pathForm2, 'utf8'),
            fs.promises.readFile(pathForm3, 'utf8')
        ]);
        
        // 3. Construir el "Mega-Prompt" usando la plantilla del .env.
        let promptTemplate = process.env.PROMPT_GENERAR_INFORME;
        const nombreUnidad = JSON.parse(jsonForm1)?.analisisOrganizacional?.nombreUnidad || 'Unidad No Especificada';
        const mesAnio = new Date().toLocaleString('es-ES', { month: 'long', year: 'numeric' });

        let finalPrompt = promptTemplate
            .replace('__NOMBRE_UNIDAD__', nombreUnidad)
            .replace('__MES_ANIO__', mesAnio.charAt(0).toUpperCase() + mesAnio.slice(1))
            .replace('__JSON_FORM_1__', jsonForm1)
            .replace('__JSON_FORM_2__', jsonForm2)
            .replace('__JSON_FORM_3__', jsonForm3);

        // 4. Llamar a la IA para generar el informe.
        console.log("[Report Gen] Enviando prompt final a Gemini...");
        const result = await generativeModel.generateContent(finalPrompt);
        const generatedReportText = result.response.text();
        
        // 5. Guardar el informe en la BD y añadirlo como un mensaje nuevo.
        const updatedChat = await Chat.findByIdAndUpdate(
            chatId,
            {
                $set: { informeFinal: generatedReportText }, // Guardamos el informe en su campo dedicado
                $push: { messages: { sender: 'ai', text: generatedReportText } } // Y lo añadimos a los mensajes para que aparezca en el chat
            },
            { new: true } // Para que nos devuelva el documento ya actualizado
        );
        
        console.log(`[Report Gen] Informe guardado y añadido como mensaje para el Chat ID: ${chatId}`);
        
        // 6. Devolver el chat actualizado, que es la respuesta que el frontend ya sabe manejar.
        res.status(200).json({ updatedChat: updatedChat });

    } catch (error) {
        console.error('[Report Gen] Error generando el informe:', error);
        res.status(500).json({ message: 'Error en el servidor al generar el informe.', error: error.message });
    }
});


// --- INICIAR SERVIDOR ---
app.listen(PORT, () => console.log(`Servidor backend corriendo en http://localhost:${PORT}`));