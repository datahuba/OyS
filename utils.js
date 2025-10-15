const fs = require('fs');
const path = require('path');
const mammoth = require("mammoth");
const xlsx = require('xlsx');
const pdf = require('pdf-parse');
const axios = require('axios');
const FormData = require('form-data');
const CONVERSION_SERVICE_URL = process.env.CONVERSION_SERVICE_URL;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const DELAY_MS = 10;

const { Mistral } = require('@mistralai/mistralai');
// Inicializa el cliente de Mistral una sola vez
const mistralApiKey = process.env.MISTRAL_API_KEY;
if (!mistralApiKey) {
    console.warn("ADVERTENCIA: La variable de entorno MISTRAL_API_KEY no está configurada.");
}
const mistralClient = new Mistral({ apiKey: mistralApiKey });
// INICIALIZACIÓN DEL CLIENTE DE OPENAI 
const OpenAI = require('openai');
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});



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
            console.warn("pdf-parse falló. Usando fallback de Mistral AI...");
            text = await extractTextWithMistral(filePath, clientMimeType);
            console.log(text);
            
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
            
        } catch (error) {
            console.error("Error con el servicio de conversión:", error.message);
            throw new Error('La conversión remota del archivo falló.');
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
// processAndFillForm con OPENAI ---
async function processAndFillFormWithOpenAI(file, formType) {
  console.log(`[OpenAI Service] Iniciando extracción de JSON para: ${file.originalname}`);
  try {
    const textContent = await extractTextFromFile(file);
    if (!textContent || !textContent.trim()) {
      throw new Error("No se pudo extraer contenido del archivo.");
    }

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
    finalPrompt = finalPrompt.replace('__TEXT_TO_PROCESS__', textContent);

    console.log(`[OpenAI Service] Enviando prompt para ${formType} a la API de OpenAI...`);
    
    const response = await openai.chat.completions.create({
        model: "gpt-4o", // O "gpt-3.5-turbo" si prefieres
        messages: [{ role: "user", content: finalPrompt }],
        response_format: { type: "json_object" }, 
    });

    const responseText = response.choices[0].message.content;

    const jsonData = JSON.parse(responseText);
    console.log(`[OpenAI Service] ¡JSON para ${formType} parseado con éxito!`);
    return jsonData;

  } catch (error) {
    console.error(`[OpenAI Service] Error durante el procesamiento del ${formType}:`, error.message);
    throw error; 
  }
};

module.exports = {
    extractTextFromFile,
    processAndFillForm,
    processAndFillFormWithOpenAI,
};