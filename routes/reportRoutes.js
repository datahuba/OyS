// routes/reportRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const { protect } = require('../middleware/authMiddleware');
const Chat = require('../models/Chat');
const { VertexAI } = require('@google-cloud/vertexai');
// Importamos las funciones que movimos a utils.js
const { processAndFillForm } = require('../utils.js');

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
const generativeModel = vertexAI.getGenerativeModel({ model: 'gemini-1.5-pro-002' });


// ========================================================================
// --- MANEJADOR DE REPORTES UNIVERSAL ---
// Esta función es el cerebro. Se configura para cada tipo de reporte.
// ========================================================================
async function handleReportGeneration(req, res, config) {
    const { chatId } = req.body;
    const files = req.files;

    console.log(">>>> [INICIO DE PETICIÓN] <<<<");
    console.log("NOMBRES DE CAMPO DE ARCHIVO RECIBIDOS:", Object.keys(files));

    if (!chatId) return res.status(400).json({ message: 'Se requiere un chatId.' });
    if (!files || Object.keys(files).length === 0) return res.status(400).json({ message: 'Se debe proporcionar al menos un archivo.' });

    let datosFormularios = {};
    let processedFiles = [];

    try {
        console.log(`[API /informes] Iniciando generación de informe tipo: ${config.reportType}`);
        // --- INICIO DEL BLOQUE CORREGIDO ---

// 1. Preparamos una lista de "trabajos" para no perder la correspondencia entre el tipo de formulario y su promesa.
const jobs = [];
for (const fieldName in config.formMappings) {
    if (files[fieldName]) {
        const file = files[fieldName][0];
        const formType = config.formMappings[fieldName];
        
        processedFiles.push(file);
        console.log(`  > Procesando ${file.originalname} para el campo '${formType}'`);
        
        jobs.push({
            formType: formType,
            promise: processAndFillForm(file, formType, generativeModel)
        });
    }
}

// 2. Extraemos solo las promesas y las ejecutamos todas en paralelo, esperando sus resultados.
const promises = jobs.map(job => job.promise);
const jsonResults = await Promise.all(promises);

// 3. Ahora que TENEMOS todos los resultados, construimos el objeto `datosFormularios` de forma segura y síncrona.
for (let i = 0; i < jobs.length; i++) {
    const formType = jobs[i].formType; // Obtenemos el tipo de formulario del job
    const json = jsonResults[i];          // Obtenemos el JSON del resultado en el mismo índice
    datosFormularios[formType] = json;
}
// En este punto, `datosFormularios` está 100% garantizado que estará lleno con todos los JSON.

// --- FIN DEL BLOQUE CORREGIDO ---

        // 2. Construir y ejecutar el prompt según la configuración
        let promptTemplate = process.env[config.promptEnvVar];
        if (!promptTemplate) throw new Error(`Prompt no encontrado en .env: ${config.promptEnvVar}`);

        // Reemplazar placeholders en el prompt
        // --- INICIO DE BLOQUE DE DEPURACIÓN AVANZADA ---
        console.log("\n--- INICIANDO DEPURACIÓN DE REEMPLAZO DE PLACEHOLDER ---");

        // 1. ¿Qué datos tenemos realmente?
        console.log("Claves disponibles en 'datosFormularios':", Object.keys(datosFormularios));
        for (const fieldName in config.formMappings) {
            const formType = config.formMappings[fieldName]; // ej: 'form1', 'form2', 'comp'
            
            // Construimos el placeholder que esperamos encontrar en el prompt.
            const placeholder = `_JSON_${formType.toUpperCase()}_`;
            console.log(`Intentando reemplazar el placeholder: "${placeholder}"`);
            // Verificamos si tenemos datos para este formType.
            console.log(`Últimos 500 caracteres del prompt ANTES del reemplazo:\n...${promptTemplate.slice(-500)}`);
            console.log(`¿El prompt contiene "${placeholder}"? : ${promptTemplate.includes(placeholder)}`);
            
            if (datosFormularios[formType]) {
                console.log(`> Reemplazando placeholder: ${placeholder}`);
                promptTemplate = promptTemplate.replace(
                    placeholder, 
                    JSON.stringify(datosFormularios[formType], null, 2)
                );
            } else {
                console.log(`> ADVERTENCIA: No se encontraron datos para '${formType}', no se reemplazará ${placeholder}.`);
                // Opcional: reemplazar con un valor por defecto si no hay datos
                // promptTemplate = promptTemplate.replace(placeholder, '"No proporcionado."');
            }
        }
                console.log("\n--- DEPURACIÓN FINAL ---");
        // 5. ¿El placeholder sigue ahí después de todo?
        const finalPlaceholder = `_JSON_COMP_`;
        console.log(`Últimos 500 caracteres del prompt DESPUÉS del reemplazo:\n...${promptTemplate.slice(-500)}`);
        console.log(`¿El placeholder "${finalPlaceholder}" sigue existiendo? : ${promptTemplate.includes(finalPlaceholder)}`);
        console.log("--- FIN DE DEPURACIÓN ---\n");

        console.log(`[Report Gen Service] Enviando prompt para ${config.reportType}...`);
        const request = { contents: [{ role: 'user', parts: [{ text: promptTemplate }] }] };
        const result = await generativeModel.generateContent(request);
        const generatedReportText = result.response.candidates[0].content.parts[0].text;

        // 3. Guardar en la base de datos
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