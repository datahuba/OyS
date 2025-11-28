// --- Dependencias para la extracción de texto ---
const fs = require('fs');
const path = require('path');
const mammoth = require("mammoth");
const xlsx = require('xlsx');
const pdf = require('pdf-parse');
const axios = require('axios');
const FormData = require('form-data');
const { Mistral } = require('@mistralai/mistralai');
const { GoogleGenerativeAI } = require("@google/generative-ai");


// SECCIÓN 2: CONFIGURACIÓN DE CLIENTES
const mistralClient = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
let embeddingModel; 

// SECCIÓN 3: FUNCIONES DE PROCESAMIENTO
/**
 * Función getEmbedding: Convierte texto en un vector numérico.
 * Movida desde server.js y ahora vive aquí.
 */
const getEmbedding = async (text) => {
    try {
        // Inicialización "lazy" para asegurar que siempre tenemos el modelo
        if (!embeddingModel) {
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            embeddingModel = genAI.getGenerativeModel({ model: "embedding-001" });
        }
        const result = await embeddingModel.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        console.error("Error al generar embedding:", error);
        throw new Error("No se pudo generar el embedding.");
    }
};

/**
 * Tu función extractTextFromFile: Intacta, tal como la querías.
 */
async function extractTextFromFile(file){
    const filePath = file.path;
    const clientMimeType = file.mimetype;
    const originalFilename = file.originalname;
    const fileExt = path.extname(file.originalname).toLowerCase();
    let text = '';

    // CASO 0: DOCX (mammoth)
    if (fileExt === '.docx'){
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
else if (['.pptx','.vsdx','.ppt','.vsd','.doc','.xls'].includes(fileExt)) {
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
}}
    

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

/**
 * Función de ayuda para Mistral (requerida por extractTextFromFile).
 */
async function extractTextWithMistral(filePath, mimetype) {
    const fileBuffer = fs.readFileSync(filePath);
    const base64File = fileBuffer.toString('base64');
    const dataUri = `data:${mimetype};base64,${base64File}`;
    const ocrResponse = await mistralClient.ocr.process({
        model: "mistral-ocr-latest",
        document: { type: 'document_url', documentUrl: dataUri },
    });
    return ocrResponse.pages.map(page => page.markdown).join('\n\n');
}

/**
 * Función chunkTextSmart: La versión mejorada que reemplaza a tu antiguo chunkDocument.
 * Divide el texto de forma semántica, respetando las frases.
 */
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
