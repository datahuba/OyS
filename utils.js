const fs = require('fs');
const path = require('path');
const mammoth = require("mammoth");
const xlsx = require('xlsx');
const pdf = require('pdf-parse');
const axios = require('axios');
const FormData = require('form-data');
const { google } = require('googleapis');
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

async function getTextViaGoogleDriveConversion(filePath, originalMimeType, originalFilename) {
    console.log(`[Google Drive] Iniciando conversión para: ${originalFilename}`);

    const GOOGLE_DRIVE_FOLDER_ID = '1f1ShEzlB-fY1_l-0YxWnhdTIWxejOBwP'; 

    // Si usas keyFile: indica la ruta al JSON de la service account.
    const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/drive'],
        // keyFile: '/path/to/service-account.json', // <- descomenta si usas service account local
        // clientOptions: { subject: 'user@tu-dominio.com' } // <- si usas domain-wide delegation
    });

    const drive = google.drive({ version: 'v3', auth });

    let tempFileId = null;

    try {
        // Subir y pedir conversión a Google Docs
        const createRes = await drive.files.create({
            requestBody: {
                name: `temp_conversion_${Date.now()}_${originalFilename}`,
                mimeType: 'application/vnd.google-apps.document',
                parents: [GOOGLE_DRIVE_FOLDER_ID]
            },
            media: {
                mimeType: originalMimeType,
                body: fs.createReadStream(filePath)
            },
            supportsAllDrives: true,
            fields: 'id'
        });

        tempFileId = createRes.data.id;
        if (!tempFileId) throw new Error('La subida no devolvió ID de archivo.');

        console.log(`[Google Drive] Archivo convertido con ID temporal: ${tempFileId}`);

        // Exportar a texto plano — usar arraybuffer y convertir a string
        const exportRes = await drive.files.export({
            fileId: tempFileId,
            mimeType: 'text/plain'
        }, { responseType: 'arraybuffer', supportsAllDrives: true });

        const exportedBuffer = Buffer.from(exportRes.data);
        const text = exportedBuffer.toString('utf8');

        console.log(`[Google Drive] Extracción de texto completada. ${text.length} bytes.`);
        return text;

    } catch (error) {
        // Log más detallado para depurar
        console.error('[Google Drive] Error durante el proceso de conversión:');
        console.error('message:', error.message);
        if (error.code) console.error('code:', error.code);
        if (error.errors) console.error('errors:', JSON.stringify(error.errors, null, 2));
        if (error.response && error.response.data) {
            console.error('response.data:', typeof error.response.data === 'object' ? JSON.stringify(error.response.data, null, 2) : error.response.data);
        }
        throw new Error('La conversión con la API de Google Drive falló.');
    } finally {
        if (tempFileId) {
            try {
                await drive.files.delete({ fileId: tempFileId, supportsAllDrives: true });
                console.log(`[Google Drive] Archivo temporal ${tempFileId} eliminado.`);
            } catch (cleanupError) {
                console.error(`[Google Drive] Fallo al eliminar el archivo temporal ${tempFileId}:`, cleanupError.message);
                if (cleanupError.response && cleanupError.response.data) console.error(cleanupError.response.data);
            }
        }
    }
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
        // 1. Crear un formulario de datos para enviar el archivo.
        // Esto es equivalente a un <form> HTML con un <input type="file">.
        const formData = new FormData();
        
        // 2. Adjuntar el buffer del archivo al formulario.
        // El primer argumento 'file' es el nombre del campo que el microservicio esperará.
        // El segundo es el contenido del archivo.
        // El tercero es el nombre del archivo original.
        formData.append('file', fileBuffer, originalFilename);

        // 3. Realizar la petición POST al microservicio de conversión.
        // Se envía el formulario y se especifica que la respuesta esperada es un stream de datos.
        const response = await axios.post(CONVERSION_SERVICE_URL, formData, {
            headers: {
                // Axios y form-data se encargan de establecer el 'Content-Type' a 'multipart/form-data'
                // y de calcular los boundaries necesarios.
                ...formData.getHeaders()
            },
            // 'arraybuffer' es crucial para recibir el archivo PDF de vuelta como datos binarios.
            responseType: 'arraybuffer' 
        });

        // 4. Devolver los datos del PDF convertido.
        // La respuesta (`response.data`) contendrá el buffer del archivo PDF.
        // Ahora puedes hacer lo que necesites con él: guardarlo, enviarlo al cliente, etc.
        console.log(`Conversión exitosa desde el microservicio. Se recibió un PDF de ${response.data.length} bytes.`);
        
        // Aquí retornarías el resultado para que el resto de tu aplicación lo procese.
        // Por ejemplo:
        // return response.data; 

    } catch (error) {
        // Manejo de errores mejorado para dar más contexto.
        console.error("Error al comunicarse con el microservicio de conversión:", error.message);
        if (error.response) {
            // El error vino desde el microservicio (ej. error 400, 500).
            console.error("Respuesta del microservicio:", error.response.status, error.response.data.toString());
            throw new Error(`El microservicio de conversión falló con el código de estado ${error.response.status}.`);
        } else if (error.request) {
            // La petición se hizo pero no se recibió respuesta.
            throw new Error(`No se recibió respuesta desde el microservicio en ${CONVERSION_SERVICE_URL}.`);
        } else {
            // Ocurrió un error al configurar la petición.
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
            console.log(text);
            
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
        model: "gpt-5-nano", // O "gpt-3.5-turbo" si prefieres
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
    return jsonData;

  } catch (error) {
    console.error(`[Multi-File Service] Error durante el procesamiento de múltiples archivos para ${formType}:`, error.message);
    throw error; 
  }
};
module.exports = {
    extractTextFromFile,
    processAndFillForm,
    processAndFillFormWithOpenAI,
    processMultipleFilesAndFillForm,
};