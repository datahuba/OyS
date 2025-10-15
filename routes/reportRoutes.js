// routes/reportRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const { protect } = require('../middleware/authMiddleware');
const Chat = require('../models/Chat');
const { VertexAI } = require('@google-cloud/vertexai');
// Importamos las funciones que movimos a utils.js
const { processAndFillForm, processAndFillFormWithOpenAI } = require('../utils.js');

// --- CONFIGURACIÓN DE MULTER ---
// Lo configuramos para aceptar todos los posibles nombres de campo que usaremos.
const upload = multer({ dest: 'uploads/' }).fields([
    { name: 'form1File', maxCount: 1 },
    { name: 'form2File', maxCount: 1 },
    { name: 'form3File', maxCount: 1 },
    { name: 'compFile', maxCount: 1 } // Campo para el consolidado
]);

// --- INICIALIZACIÓN DE IA ---
const vertexAI = new VertexAI({ project: process.env.GOOGLE_CLOUD_PROJECT || 'onlyvertex-474004', location: 'us-central1' });
const generativeModel = vertexAI.getGenerativeModel({ model: 'gemini-2.5-pro' });


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
        
        // Creamos un array de promesas, una para cada archivo, usando .map()
        const processingPromises = Object.keys(config.formMappings).map(fieldName => {
            if (files[fieldName]) {
                const file = files[fieldName][0];
                const formType = config.formMappings[fieldName];
                console.log(`  > Asignando ${file.originalname} a OpenAI para extracción de JSON...`);
                // Llamamos a la función específica de OpenAI
                return processAndFillFormWithOpenAI(file, formType);
            }
            return null; // Devolvemos null para los campos de archivo que no se enviaron
        }).filter(p => p !== null); // Filtramos los nulos

        // Obtenemos los formTypes en el mismo orden para mapear los resultados correctamente
        const formTypesInOrder = Object.keys(config.formMappings)
            .filter(fieldName => files[fieldName])
            .map(fieldName => config.formMappings[fieldName]);

        console.log("> Ejecutando todas las extracciones de JSON en paralelo con OpenAI (`Promise.all`)...");
        const results = await Promise.all(processingPromises);
        console.log("> ¡Todas las extracciones de JSON con OpenAI han terminado!");

        // Mapeamos los resultados de vuelta a nuestro objeto
        results.forEach((jsonResult, index) => {
            const formType = formTypesInOrder[index];
            datosFormularios[formType] = jsonResult;
        });

        // --- ETAPA 2: Generación del Reporte Final con Google (Gemini) ---
        
        let promptTemplate = process.env[config.promptEnvVar];
        if (!promptTemplate) throw new Error(`Prompt no encontrado en .env: ${config.promptEnvVar}`);

        // Rellenamos el prompt con los JSONs que obtuvimos de OpenAI
        for (const formType in datosFormularios) {
            const placeholder = `_JSON_${formType.toUpperCase()}_`;
            promptTemplate = promptTemplate.replace(placeholder, JSON.stringify(datosFormularios[formType], null, 2));
        }

        console.log(`[Report Gen Service] Enviando prompt final a GOOGLE para ${config.reportType}...`);
        const request = { contents: [{ role: 'user', parts: [{ text: promptTemplate }] }] };
        const result = await generativeModel.generateContent(request);
        const generatedReportText = result.response.candidates[0].content.parts[0].text;

        // --- ETAPA 3: Guardar en la Base de Datos (tu código original) ---
        const updatedChat = await Chat.findByIdAndUpdate(chatId, {
            $set: { informeFinal: generatedReportText, ...datosFormularios },
            $push: { messages: { $each: [
                { sender: 'user', text: `Generar informe: ${config.reportType}` },
                { sender: 'ai', text: generatedReportText }
            ] } }
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
            'form3File': 'form3'
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