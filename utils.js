// utils.js

const fs = require('fs');
const path = require('path');
const mammoth = require("mammoth");
const xlsx = require('xlsx');
const pdf = require('pdf-parse');
const axios = require('axios');
const FormData = require('form-data');
const { google } = require('googleapis');
const { Mistral } = require('@mistralai/mistralai');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const mistralClient = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let embeddingModel; // Se inicializará la primera vez que se use.


function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const DELAY_MS = 1000;

// --- FUNCIÓN getEmbedding (VERSIÓN SIMPLE DE AI STUDIO PARA COMPATIBILIDAD) ---
const getEmbedding = async (text) => {
    try {
        if (!embeddingModel) {
            const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_STUDIO_API_KEY);
            embeddingModel = genAI.getGenerativeModel({ model: "embedding-001" });
        }
        const result = await embeddingModel.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        console.error("Error al generar embedding:", error);
        throw new Error("No se pudo generar el embedding.");
    }
};



const chunkDocument = (text, chunkSize = 1000, overlap = 200) => { const chunks = []; for (let i = 0; i < text.length; i += chunkSize - overlap) { chunks.push(text.substring(i, i + chunkSize)); } return chunks; };

function chunkTextSmart(text, chunkSize = 1500, chunkOverlap = 150) {
    const cleanedText = text.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s\s+/g, ' ');
    const sentences = cleanedText.match(/[^.!?]+[.!?]+/g) || [];
    if (sentences.length === 0 && cleanedText) return [cleanedText];

    const chunks = [];
    let currentChunk = "";
    for (const sentence of sentences) {
        if (currentChunk.length + sentence.length <= chunkSize) {
            currentChunk += " " + sentence;
        } else {
            chunks.push(currentChunk.trim());
            const lastWords = currentChunk.substring(currentChunk.length - chunkOverlap);
            currentChunk = lastWords + " " + sentence;
        }
    }
    if (currentChunk) chunks.push(currentChunk.trim());
    return chunks;
}




async function extractTextWithMistral(filePath, mimetype) {
    console.log("Procesando con el cliente oficial de Mistral AI...");

    try {
        const fileBuffer = fs.readFileSync(filePath);
        const base64File = fileBuffer.toString('base64');
        const dataUri = `data:${mimetype};base64,${base64File}`;

        const documentType = mimetype.startsWith('image/') ? 'image_url' : 'document_url';
        const documentPayload = {
            type: documentType,
            ...(documentType === 'image_url' ? { imageUrl: dataUri } : { documentUrl: dataUri })
        };

        await delay(DELAY_MS);
        console.log(`[DELAY] Esperando ${DELAY_MS}ms antes de la llamada OCR de Mistral para ${filePath}...`);

        const ocrResponse = await mistralClient.ocr.process({
            model: "mistral-ocr-latest",
            document: documentPayload,
        });

        // --- CAMBIO AQUÍ: AÑADIDO LOG PARA DEPURACIÓN ---
        //console.log("Respuesta completa recibida de la API de Mistral:");
        //console.dir(ocrResponse, { depth: null }); // Esto imprimirá el objeto completo

        console.log("Extracción con Mistral AI completada con éxito.");

        if (ocrResponse.pages && ocrResponse.pages.length > 0) {
            return ocrResponse.pages.map(page => page.markdown).join('\n\n');
        }

        // --- CAMBIO AQUÍ: AÑADIDO WARNING ---
        console.warn("ADVERTENCIA: La API de Mistral no devolvió ninguna página de contenido. El documento podría estar en blanco o ser ilegible.");
        return '';

    } catch (error) {
        console.error('Error detallado de la API de Mistral (cliente oficial):', error);
        throw new Error('La API de Mistral AI no pudo procesar el archivo.');
    }
}


async function extractTextFromFile(file) {
    const filePath = file.path;
    const clientMimeType = file.mimetype;
    const originalFilename = file.originalname;
    const fileExt = path.extname(file.originalname).toLowerCase();
    let text = '';

    // CASO 0: DOCX (mammoth)
    if (fileExt === '.docx') {
        console.log(`Procesando localmente (DOCX): ${file.originalname}`);
        const result = await mammoth.extractRawText({ path: filePath });
        text = result.value;
    }

    // CASO 1: XLSX 
    else if (fileExt === '.xlsx') {
        console.log(`Procesando localmente (XLSX): ${file.originalname}`);
        const workbook = xlsx.readFile(filePath);
        const fullText = [];
        // Iteramos sobre cada hoja del libro de Excel
        workbook.SheetNames.forEach(sheetName => {
            const worksheet = workbook.Sheets[sheetName];
            // Convertimos el contenido de la hoja a texto plano
            const sheetText = xlsx.utils.sheet_to_txt(worksheet);
            if (sheetText && sheetText.trim()) {
                // Añadimos el contenido con un encabezado para dar contexto
                fullText.push(`--- Contenido de la hoja: "${sheetName}" ---\n${sheetText}`);
            }
        });
        // Unimos el texto de todas las hojas
        text = fullText.join('\n\n');
    }

    // CASO 2: PPTX y formatos de Office antiguos/complejos se delegan a Google Drive
    else if (['.pptx', '.vsdx', '.ppt', '.vsd', '.doc', '.xls'].includes(fileExt)) {
        const CONVERSION_SERVICE_URL = process.env.CONVERSION_SERVICE_URL;
        if (!CONVERSION_SERVICE_URL) {
            // Si no hay servicio, lanzamos un error claro en lugar de fallar silenciosamente.
            throw new Error(`La conversión para el tipo de archivo ${fileExt} requiere un microservicio, pero CONVERSION_SERVICE_URL no está configurada.`);
        }

        console.log(`Delegando la conversión de (${originalFilename}) a ${CONVERSION_SERVICE_URL}...`);

        try {
            // 1. LEER EL ARCHIVO DESDE EL DISCO
            // Esta es la línea que faltaba. Lee el contenido del archivo en un buffer.
            const fileContentBuffer = await fs.promises.readFile(filePath);

            // 2. Crear un formulario de datos para enviar el archivo.
            const formData = new FormData();

            // 3. Adjuntar el buffer del archivo al formulario.
            // Usa la variable que acabas de crear: fileContentBuffer.
            formData.append('file', fileContentBuffer, originalFilename);

            // 4. Realizar la petición POST al microservicio de conversión.
            console.log(`Enviando ${fileContentBuffer.length} bytes a ${CONVERSION_SERVICE_URL}...`);
            const response = await axios.post(CONVERSION_SERVICE_URL, formData, {
                headers: {
                    ...formData.getHeaders()
                },
                responseType: 'arraybuffer'
            });

            // 5. Procesar la respuesta
            console.log(`Conversión exitosa desde el microservicio. Se recibió un PDF de ${response.data.length} bytes.`);

            // IMPORTANTE: Ahora debes hacer algo con el PDF recibido.
            // El microservicio te devuelve el PDF, pero esta función debe devolver TEXTO.
            // Necesitas procesar el PDF que te devolvió el microservicio.
            // Podrías reutilizar tu lógica del CASO 3 (PDF).

            const pdfParser = require('pdf-parse'); // Asegúrate de que pdf-parse esté disponible
            const data = await pdfParser(response.data);
            text = data.text; // Extrae el texto del PDF convertido.

        } catch (error) {
            // ... (tu bloque catch es correcto y no necesita cambios)
            console.error("Error al comunicarse con el microservicio de conversión:", error.message);
            if (error.response) {
                console.error("Respuesta del microservicio:", error.response.status, error.response.data.toString());
                throw new Error(`El microservicio de conversión falló con el código de estado ${error.response.status}.`);
            } else if (error.request) {
                throw new Error(`No se recibió respuesta desde el microservicio en ${CONVERSION_SERVICE_URL}.`);
            } else {
                throw new Error(`Error al configurar la llamada al microservicio: ${error.message}`);
            }
        }
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
            console.warn("pdf-parse falló. Usando fallback de Mistral AI...");
            text = await extractTextWithMistral(filePath, clientMimeType);
            //console.log(text);

        }
    }


    // CASO 5: IMÁGENES
    else if (['.jpg', '.jpeg', '.png', '.webp'].includes(fileExt) || clientMimeType.startsWith('image/')) {
        console.log(`Procesando (Imagen) con Mistral OCR: ${file.originalname}`);
        text = await extractTextWithMistral(filePath, clientMimeType);
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

async function processMultipleFilesAndFillForm(files, formType) {
    console.log(`[Multi-File Service] Iniciando extracción de JSON para ${files.length} archivos (tipo: ${formType}).`);

    try {
        // --- ETAPA 1: Extracción de texto secuencial y concatenación ---
        let allExtractedTexts = [];
        console.log("> Extrayendo texto de cada archivo uno por uno...");

        // Usamos un bucle for...of para poder usar 'await' correctamente dentro.
        for (const file of files) {
            console.log(`  > Procesando: ${file.originalname}`);
            const textContent = await extractTextFromFile(file);

            // ¡Mejora! Añadimos un separador y el nombre del archivo para darle contexto a la IA.
            const formattedText = `--- INICIO DEL DOCUMENTO: ${file.originalname} ---\n\n${textContent}\n\n--- FIN DEL DOCUMENTO: ${file.originalname} ---`;
            allExtractedTexts.push(formattedText);
        }

        // Unimos todo el texto extraído en una sola gran cadena de texto.
        const combinedText = allExtractedTexts.join('\n\n');

        if (!combinedText || !combinedText.trim()) {
            throw new Error("No se pudo extraer contenido de ninguno de los archivos.");
        }

        // --- ETAPA 2: Una sola llamada a OpenAI con el texto combinado ---
        const promptKey = `PROMPT_${formType.toUpperCase()}`;
        const schemaPath = path.join(__dirname, 'schemas', `${formType}.schema.json`);

        const [promptTemplate, schemaFileContent] = await Promise.all([
            process.env[promptKey],
            fs.promises.readFile(schemaPath, 'utf8')
        ]);

        if (!promptTemplate) {
            throw new Error(`El prompt para ${formType} no se encontró en el archivo .env`);
        }

        let finalPrompt = promptTemplate.replace('__JSON_SCHEMA__', schemaFileContent);
        finalPrompt = finalPrompt.replace('__TEXT_TO_PROCESS__', combinedText); // Usamos el texto combinado

        console.log(`[Multi-File Service] Enviando prompt combinado a la API de OpenAI...`);

        const response = await openai.chat.completions.create({
            model: "gpt-5-nano",
            messages: [{ role: "user", content: finalPrompt }],
            response_format: { type: "json_object" },
        });

        const responseText = response.choices[0].message.content;
        const jsonData = JSON.parse(responseText);

        console.log(`[Multi-File Service] ¡JSON combinado para ${formType} parseado con éxito!`);
        //console.log(jsonData)
        return jsonData;

    } catch (error) {
        console.error(`[Multi-File Service] Error durante el procesamiento de múltiples archivos para ${formType}:`, error.message);
        throw error;
    }
};

async function createVectorsForDocument(file, documentId) {
    // 1. Usa tu extractor avanzado
    const text = await extractTextFromFile(file);
    if (!text || !text.trim()) {
        console.warn(`No se pudo extraer texto del archivo ${file.originalname}, se omitirá.`);
        return [];
    }

    // 2. Divide el texto usando el método semántico mejorado
    const chunks = chunkTextSmart(text);
    console.log(`[Procesador RAG] "${file.originalname}" dividido en ${chunks.length} chunks.`);

    // 3. Genera un embedding para cada chunk y prepara el objeto para Pinecone
    const vectorsToUpsert = await Promise.all(
        chunks.map(async (chunk, index) => {
            const chunkWithContext = `Este texto es del archivo llamado "${file.originalname}". Contenido: ${chunk}`;
            const embeddingValues = await getEmbedding(chunkWithContext);

            return {
                id: `${documentId}_chunk_${index}`,
                values: embeddingValues,
                metadata: {
                    documentId,
                    originalName: file.originalname,
                    chunkText: chunk // Guardamos el texto limpio para el contexto de la IA
                },
            };
        })
    );
    return vectorsToUpsert;
}

module.exports = {
    createVectorsForDocument,
    getEmbedding,
    extractTextFromFile,
    processMultipleFilesAndFillForm,
    chunkDocument,
};