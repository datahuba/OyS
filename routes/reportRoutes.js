// routes/reportRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const { protect } = require('../middleware/authMiddleware');
const Chat = require('../models/Chat');
//const { VertexAI } = require('@google-cloud/vertexai');
const { OpenAI } = require('openai');
// Importamos las funciones que movimos a utils.js
const { processAndFillFormWithOpenAI } = require('../utils.js');
const { processMultipleFilesAndFillForm } = require('../utils.js');

// --- CONFIGURACIÓN DE MULTER ---
// Lo configuramos para aceptar todos los posibles nombres de campo que usaremos.
const upload = multer({ dest: 'uploads/' }).fields([
    { name: 'form1File', maxCount: 20 },
    { name: 'form2File', maxCount: 20 },
    { name: 'form3File', maxCount: 20 },
    { name: 'form4File', maxCount: 20 },
    { name: 'compFile', maxCount: 20 } // Campo para el consolidado
]);

// --- INICIALIZACIÓN DE IA ---
//const vertexAI = new VertexAI({ project: process.env.GOOGLE_CLOUD_PROJECT || 'onlyvertex-474004', location: 'us-central1' });
//const generativeModel = vertexAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
// --- INICIALIZACIÓN DEL CLIENTE DE OPENAI (PARA LA GENERACIÓN DE REPORTES) ---
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
console.log("[API /informes] Cliente de OpenAI inicializado para la generación de reportes.");

// ========================================================================
// --- MANEJADOR DE REPORTES UNIVERSAL ---
// Esta función es el cerebro. Se configura para cada tipo de reporte.
// ========================================================================
async function handleReportGeneration(req, res, config) {
    const { chatId } = req.body;
    const files = req.files;

    if (!chatId) return res.status(400).json({ message: 'Se requiere un chatId.' });
    if (!files || Object.keys(files).length === 0) return res.status(400).json({ message: 'Se deben proporcionar archivos.' });

    // Obtenemos una lista plana de todos los archivos para el cleanup final
    const processedFiles = Object.values(files).flat(); 
    let datosFormularios = {};

    try {
        console.log(`[API /informes] Iniciando generación de informe HÍBRIDO tipo: ${config.reportType}`);
        
        // --- ETAPA 1: Extracción de JSON en Paralelo con OpenAI ---
        console.log("> Preparando tareas de extracción de JSON para todos los archivos...");
         const processingPromises = Object.keys(config.formMappings).map(fieldName => {
            // Verificamos si se subieron archivos para este campo (ej. 'form1File')
            if (files[fieldName] && files[fieldName].length > 0) {
                const formType = config.formMappings[fieldName];
                const filesForThisType = files[fieldName]; // Este es el ARRAY de archivos

                console.log(`  > Asignando ${filesForThisType.length} archivos al servicio multi-documento para el tipo: ${formType}`);
                
                // --- ¡CAMBIO CLAVE AQUÍ! ---
                // Llamamos a la nueva función, pasándole el array completo de archivos para este tipo.
                return processMultipleFilesAndFillForm(filesForThisType, formType)
                    .then(jsonResult => ({ formType, jsonResult })); // Devolvemos un objeto para saber a qué tipo pertenece el resultado
            }
            return null; // Si no hay archivos para este campo, no hacemos nada.
        }).filter(p => p !== null);

        if (processingPromises.length === 0) {
            throw new Error("No se encontraron archivos válidos para procesar según la configuración.");
        }

        console.log(`> Ejecutando ${processingPromises.length} extracciones de JSON en paralelo (una por tipo de formulario)...`);
        const results = await Promise.all(processingPromises);
        console.log("> ¡Todas las extracciones de JSON han terminado!");

        // Mapeamos los resultados de vuelta a nuestro objeto `datosFormularios`
        // El resultado de `processMultipleFilesAndFillForm` es un único JSON, no un array de JSONs.
        results.forEach(result => {
            datosFormularios[result.formType] = result.jsonResult;
        });
        

         // --- ¡CAMBIO! ETAPA 2: Generación del Reporte Final con OpenAI ---
        
        let promptTemplate = process.env[config.promptEnvVar];
        if (!promptTemplate) throw new Error(`Prompt no encontrado en .env: ${config.promptEnvVar}`);

        for (const formType in datosFormularios) {
            const placeholder = `_JSON_${formType.toUpperCase()}_`;
            promptTemplate = promptTemplate.replace(placeholder, JSON.stringify(datosFormularios[formType], null, 2));
        }

        console.log(`[Report Gen Service] Enviando prompt final a OPENAI para ${config.reportType}...`);
        
        // ¡Llamada directa a la API de OpenAI!
        const response = await openai.chat.completions.create({
            model: "gpt-5-nano", // O el modelo que prefieras
            messages: [{ role: "user", content: promptTemplate }],
        });

        const generatedReportText = response.choices[0].message.content;

        // --- ETAPA 3: Guardar en la Base de Datos (CON LÓGICA DE DEBUG) ---
        const userMessage = { sender: 'user', text: `Generar informe: ${config.reportType}` };
        const aiMessage = { sender: 'ai', text: generatedReportText };
        const messagesToPush = [userMessage, aiMessage];

        const currentChat = await Chat.findById(chatId);

        if (currentChat && currentChat.debugMode) {
            const debugMessage = {
                sender: 'bot',
                text: "--- DEBUG: JSONs Extraídos ---\n```json\n" + 
                      JSON.stringify(datosFormularios, null, 2) + 
                      "\n```"
            };
            messagesToPush.push(debugMessage);
        }

        const updatedChat = await Chat.findByIdAndUpdate(chatId, {
            $set: { informeFinal: generatedReportText, ...datosFormularios },
            $push: { messages: { $each: messagesToPush } }
        }, { new: true });

        if (!updatedChat) return res.status(404).json({ message: "Chat no encontrado." });
        
        console.log(`[API /informes] Informe '${config.reportType}' guardado para Chat ID: ${chatId}`);
        res.status(200).json({ updatedChat });

    } catch (error) {
        console.error(`[API /informes] Error en el flujo '${config.reportType}':`, error);
        await Chat.findByIdAndUpdate(chatId, { $push: { messages: { sender: 'bot', text: `Error al generar el informe: ${error.message}` } } });
        res.status(500).json({ message: 'Error en el servidor.', details: error.message });
    } finally {
        processedFiles.forEach(file => fs.existsSync(file.path) && fs.unlinkSync(file.path));
    }
}



// ========================================================================
// --- DEFINICIÓN DE LAS RUTAS Y SUS CONFIGURACIONES ---
// ========================================================================

const reportConfigs = {
    facultativa: {
        reportType: 'Compatibilización Facultativa',
        promptEnvVar: 'PROMPT_COMP_FACULTATIVA',
        formMappings: {
            'form1File': 'form1',
            'form2File': 'form2',
            'form3File': 'form3'
        }
    },
    administrativa: {
        reportType: 'Compatibilización Administrativa',
        promptEnvVar: 'PROMPT_COMP_ADMINISTRATIVA',
        formMappings: {
            'form1File': 'form1',
            'form2File': 'form2',
            'form3File': 'form3',
            'form4File': 'extra'
        }
    },
    consolidado: {
        reportType: 'Consolidado',
        promptEnvVar: 'PROMPT_CONSOLIDADO',
        formMappings: {
            'form1File': 'comp' // El archivo se llama 'compFile', se procesa como 'comp' y su JSON reemplaza __JSON_COMP__
        }
    }
};

// --- CREACIÓN DE LOS 3 ENDPOINTS ---
router.post('/generar-comp-facultativa', protect, upload, (req, res) => {
    handleReportGeneration(req, res, reportConfigs.facultativa);
});

router.post('/generar-comp-administrativa', protect, upload, (req, res) => {
    handleReportGeneration(req, res, reportConfigs.administrativa);
});

router.post('/generar-consolidado', protect, upload, (req, res) => {
    handleReportGeneration(req, res, reportConfigs.consolidado);
});

module.exports = router;