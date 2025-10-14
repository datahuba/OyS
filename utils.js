const fs = require('fs');
const path = require('path');
const mammoth = require("mammoth");
const xlsx = require('xlsx');
const pdf = require('pdf-parse');
const axios = require('axios');
const FormData = require('form-data');
const CONVERSION_SERVICE_URL = process.env.CONVERSION_SERVICE_URL;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const DELAY_MS = 10000;


// Función para extraer texto de PDFs con Gemini (nuestro fallback)
async function extractTextWithGemini(filePath, mimetype, generativeModel) {
    await delay(DELAY_MS);
    console.log(`[DELAY] Esperando ${DELAY_MS}ms antes de la llamada OCR para ${filePath}...`);

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
async function describeImageWithGemini(filePath, mimetype, originalName, generativeModel) {
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
async function extractTextFromFile(file, generativeModel){
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
            text = await extractTextWithGemini(filePath, clientMimeType, generativeModel);
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
        text = await describeImageWithGemini(filePath, clientMimeType, file.originalname, generativeModel);
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

async function processAndFillForm(file, formType, generativeModel) {
      console.log(`[JSON Extractor] Iniciando para el formulario tipo: ${formType}`);

  try {
    const textContent = await extractTextFromFile(file, generativeModel);
    if (!textContent || !textContent.trim()) {
      throw new Error("No se pudo extraer contenido del archivo o está vacío.");
    }

    // Cargar el prompt
    const promptKey = `PROMPT_${formType.toUpperCase()}`;
    console.log(promptKey);
    // Cargar esquema JSON
    const schemaPath = path.join(__dirname, 'schemas', `${formType}.schema.json`);
    const [promptTemplate, schemaFileContent] = await Promise.all([process.env[promptKey],fs.promises.readFile(schemaPath, 'utf8')]);
    console.log(promptTemplate); 
    if (!promptTemplate) {
        throw new Error(`El prompt para ${formType} no se encontró en el archivo .env`);
    }

    // Armar promp con pedazos
    let finalPrompt = promptTemplate.replace('__JSON_SCHEMA__', schemaFileContent);
    finalPrompt = finalPrompt.replace('__TEXT_TO_PROCESS__', textContent);
    
    // API
    await delay(DELAY_MS);
    console.log(`[DELAY] Esperando ${DELAY_MS}ms antes de la llamada de extracción JSON para ${file.originalname}...`);
    
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


module.exports = {
    extractTextFromFile,
    processAndFillForm
};