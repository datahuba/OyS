require('dotenv').config();
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
const vertexAI = new VertexAI({ project: 'onlyvertex-474004', location: 'us-central1' });
// Modelos de Google AI
const generativeModel = vertexAI.getGenerativeModel({model: 'gemini-2.5-pro',});
const embeddingModel = vertexAI.getGenerativeModel({model: "embedding-001",});

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
    console.log("Fallback: Intentando extracción de PDF con Vertex AI Vision...");
    const fileBuffer = fs.readFileSync(filePath);
    const filePart = { inlineData: { data: fileBuffer.toString("base64"), mimeType: mimetype } };
    const prompt = "Extrae todo el texto de este documento. Devuelve únicamente el texto plano, sin ningún formato adicional, como si lo copiaras y pegaras. No resumas nada.";
    
    // El request debe tener un formato específico para Vertex AI
    const request = {
        contents: [{ role: 'user', parts: [ {text: prompt}, filePart ] }],
    };

    try {
        const result = await generativeModel.generateContent(request);
        // La estructura de la respuesta también cambia
        return result.response.candidates[0].content.parts[0].text;
    } catch (error) {
        console.error('Error detallado de la API de Vertex AI:', error); 
        throw new Error('La API de Vertex AI no pudo procesar el archivo.');
    }
}

// --- NUEVO: Función para describir imágenes con Gemini ---
async function describeImageWithGemini(filePath, mimetype, originalName) {
    console.log("Procesando imagen con Vertex AI Vision...");
    const fileBuffer = fs.readFileSync(filePath);
    const filePart = { inlineData: { data: fileBuffer.toString("base64"), mimeType: mimetype } };
    const prompt = "Describe detalladamente esta imagen. Si contiene texto, transcríbelo. Si es un diagrama, explica lo que representa. Si es una foto, describe la escena y los objetos.";
    
    const request = {
        contents: [{ role: 'user', parts: [ {text: prompt}, filePart ] }],
    };

    try {
        const result = await generativeModel.generateContent(request);
        const description = result.response.candidates[0].content.parts[0].text;
        return `Descripción de la imagen "${originalName}":\n${description}`;
    } catch (error) {
        console.error('Error detallado de la API de Vertex AI Vision:', error);
        throw new Error('La API de Vertex AI no pudo procesar la imagen.');
    }
}

//---------------------------------------------------------------------------------------
// En server.js, junto a tus otras funciones como getEmbedding, etc.

async function generateAndSaveReport(chatId, userQuery) {
    try {
        let chat = await Chat.findById(chatId);
        if (!chat) throw new Error("Chat no encontrado para la generación del informe.");

        // 1. Leer los JSON directamente desde los campos del chat
        const jsonForm1 = chat.formulario1Data;
        const jsonForm2 = chat.formulario2Data;
        const jsonForm3 = chat.formulario3Data;

        // Versión flexible: solo falla si no hay NINGÚN dato
        if (!jsonForm1 && !jsonForm2 && !jsonForm3) {
            throw new Error('No se ha subido ningún archivo de formulario para analizar.');
        }

        // 2. Construir el Mega-Prompt
        const stringForm1 = jsonForm1 ? JSON.stringify(jsonForm1, null, 2) : '"No proporcionado."';
        const stringForm2 = jsonForm2 ? JSON.stringify(jsonForm2, null, 2) : '"No proporcionado."';
        const stringForm3 = jsonForm3 ? JSON.stringify(jsonForm3, null, 2) : '"No proporcionado."';

        let promptTemplate = process.env.PROMPT_GENERAR_INFORME;
        const nombreUnidad = jsonForm1?.analisisOrganizacional?.nombreUnidad || 'Unidad No Especificada';
        const mesAnio = new Date().toLocaleString('es-ES', { month: 'long', year: 'numeric' });

        let finalPrompt = promptTemplate
            .replace('__NOMBRE_UNIDAD__', nombreUnidad)
            .replace('__MES_ANIO__', mesAnio.charAt(0).toUpperCase() + mesAnio.slice(1))
            .replace('__JSON_FORM_1__', stringForm1)
            .replace('__JSON_FORM_2__', stringForm2)
            .replace('__JSON_FORM_3__', stringForm3);

        // 3. Llamar a la IA
        const request = { contents: [{ role: 'user', parts: [{ text: finalPrompt }] }] };
        const result = await generativeModel.generateContent(request);
        const generatedReportText = result.response.candidates[0].content.parts[0].text;

        // 4. Guardar el informe y los mensajes en la BD
        const updatedChatWithReport = await Chat.findByIdAndUpdate(chatId, {
            $set: { informeFinal: generatedReportText },
            $push: { messages: { $each: [
                { sender: 'user', text: userQuery },
                { sender: 'ai', text: generatedReportText }
            ]}}
        }, { new: true });
        
        console.log(`[Report Gen] Informe generado y guardado para el Chat ID: ${chatId}`);

        // 5. Devolver el chat actualizado para que la ruta principal lo envíe al frontend
        return updatedChatWithReport;

    } catch (error) {
        console.error('[Report Gen] Error:', error.message);
        
        // Guardamos el mensaje de error en el chat
        const chatWithError = await Chat.findByIdAndUpdate(chatId, {
            $push: { messages: { $each: [
                 { sender: 'user', text: userQuery },
                 { sender: 'bot', text: `Ocurrió un error al generar el informe: ${error.message}` }
            ]}}
        }, { new: true });
        
        // Devolvemos el chat con el mensaje de error para que el frontend se actualice
        // y propagamos el error para que la ruta principal sepa que algo falló.
        throw chatWithError; 
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
    
    const request = { contents: [{ role: 'user', parts: [{ text: finalPrompt }] }] };
    const result = await generativeModel.generateContent(request);
    
    const responseText = result.response.candidates[0].content.parts[0].text;

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







// --- FUNCIÓN getEmbedding (VERSIÓN FINAL CON HTTP DIRECTO) ---
const getEmbedding = async (text) => {
    try {
        // 1. Obtenemos las credenciales y el token de acceso automáticamente.
        const auth = new GoogleAuth({
            scopes: 'https://www.googleapis.com/auth/cloud-platform'
        });
        const client = await auth.getClient();
        const accessToken = (await client.getAccessToken()).token;

        // 2. Definimos el endpoint y el cuerpo de la petición.
        const projectId = process.env.GOOGLE_CLOUD_PROJECT; // Leído desde env-vars.yaml
        const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/text-embedding-004:predict`;
        
        const data = {
            instances: [ { content: text, taskType: "RETRIEVAL_DOCUMENT" } ]
        };

        // 3. Hacemos la llamada a la API con Axios.
        const response = await axios.post(url, data, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        // 4. Extraemos el embedding de la respuesta.
        return response.data.predictions[0].embeddings.values;

    } catch (error) {
        console.error("Error al generar embedding (HTTP):", error.response ? error.response.data : error.message);
        throw new Error("No se pudo generar el embedding.");
    }
};

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
        res.json({ updatedChat: chat });
    } catch (error) { res.status(500).json({ message: 'Error al obtener chat', error: error.message }); }
});

app.post('/api/chats', protect, async (req, res) => {
    try {
        const newChat = new Chat({ title: 'Nuevo Chat', messages: [], userId: req.user._id });
        await newChat.save();
        res.status(201).json({ updatedChat: newChat });
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

               // --- GATILLO PARA GENERAR INFORME (Lógica Síncrona) ---
        if (userQuery.toLowerCase() === 'generar informe') {
            try {
                console.log(`[Chat API] Gatillo de informe detectado. Esperando a la función...`);
                
                // Usamos 'await' para esperar el resultado.
                const updatedChat = await generateAndSaveReport(chatId, userQuery);

                // Devolvemos el chat con el informe o con el mensaje de error.
                return res.status(200).json({ updatedChat: updatedChat });

            } catch (chatWithError) {
                // Si la función lanza un error, a menudo será el objeto de chat con el mensaje de error.
                // Si no, es un error del sistema.
                if (chatWithError && chatWithError.messages) {
                    return res.status(200).json({ updatedChat: chatWithError });
                }
                // Si el error es inesperado, devolvemos un 500.
                return res.status(500).json({ message: "Error crítico al generar el informe." });
            }
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
        const request = {contents: contents,};
        const result = await generativeModel.generateContent(request);
        const botText = result.response.candidates[0].content.parts[0].text;

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
        
        // 1. Extraemos el JSON (esto no cambia)
        const filledJson = await processAndFillForm(file, formType);

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

// En server.js, después de la ruta /api/extract-json

// ========================================================================
// --- RUTA PARA GENERAR EL INFORME DE COMPATIBILIZACIÓN ---
// ========================================================================
app.post('/api/generate-report', protect, async (req, res) => {
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

        // 1. Encontrar y leer los archivos JSON
        const documentos = chat.consolidadoFacultades || [];
        const findJsonPath = (formType) => {
            const doc = documentos.find(d => d.metadata?.formType === formType);
            return doc ? doc.metadata.jsonPath : null;
        };
        const [pathForm1, pathForm2, pathForm3] = [findJsonPath('form1'), findJsonPath('form2'), findJsonPath('form3')];

        // Usamos la versión flexible que funciona con 1, 2 o 3 archivos
        if (!pathForm1 && !pathForm2 && !pathForm3) {
            return res.status(400).json({ message: 'No se ha subido ningún archivo de formulario para analizar.' });
        }

        const [jsonForm1, jsonForm2, jsonForm3] = await Promise.all([
            pathForm1 ? fs.promises.readFile(pathForm1, 'utf8') : Promise.resolve(null),
            pathForm2 ? fs.promises.readFile(pathForm2, 'utf8') : Promise.resolve(null),
            pathForm3 ? fs.promises.readFile(pathForm3, 'utf8') : Promise.resolve(null)
        ]);
        
        // 2. Construir el Mega-Prompt
        let promptTemplate = process.env.PROMPT_GENERAR_INFORME;
        const nombreUnidad = jsonForm1 ? (JSON.parse(jsonForm1)?.analisisOrganizacional?.nombreUnidad || 'Unidad No Especificada') : 'Unidad No Especificada';
        const mesAnio = new Date().toLocaleString('es-ES', { month: 'long', year: 'numeric' });

        let finalPrompt = promptTemplate
            .replace('__NOMBRE_UNIDAD__', nombreUnidad)
            .replace('__MES_ANIO__', mesAnio.charAt(0).toUpperCase() + mesAnio.slice(1))
            .replace('__JSON_FORM_1__', jsonForm1 || '"No proporcionado."')
            .replace('__JSON_FORM_2__', jsonForm2 || '"No proporcionado."')
            .replace('__JSON_FORM_3__', jsonForm3 || '"No proporcionado."');

        // 3. Llamar a la IA y ESPERAR la respuesta
        console.log("[Report Gen] Enviando prompt final a Vertex AI...");
        const request = { contents: [{ role: 'user', parts: [{ text: finalPrompt }] }] };
        const result = await generativeModel.generateContent(request);
        const generatedReportText = result.response.candidates[0].content.parts[0].text;
        
        // 4. Guardar el informe en la BD
        const updatedChat = await Chat.findByIdAndUpdate(
            chatId,
            {
                $set: { informeFinal: generatedReportText },
                $push: { messages: { sender: 'ai', text: generatedReportText } }
            },
            { new: true }
        );
        
        console.log(`[Report Gen] Informe guardado y añadido como mensaje para el Chat ID: ${chatId}`);
        
        // 5. Devolver el chat actualizado al frontend
        res.status(200).json({ updatedChat: updatedChat });

    } catch (error) {
        console.error('[Report Gen] Error generando el informe:', error);
        res.status(500).json({ message: 'Error en el servidor al generar el informe.', error: error.message });
    }
});

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => console.log(`Servidor backend corriendo en http://localhost:${PORT}`));
