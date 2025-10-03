// routes/reportRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const { protect } = require('../middleware/authMiddleware');
const Chat = require('../models/Chat');
const { VertexAI } = require('@google-cloud/vertexai');
const { extractTextFromFile, processAndFillForm } = require('../utils.js'); // <-- Importamos desde utils

// --- CONFIGURACIÓN DE MULTER ---
const upload = multer({ dest: 'uploads/' }).fields([
    { name: 'form1File', maxCount: 1 },
    { name: 'form2File', maxCount: 1 },
    { name: 'form3File', maxCount: 1 }
]);

// --- INICIALIZACIÓN DE IA ---
const vertexAI = new VertexAI({ project: process.env.GOOGLE_CLOUD_PROJECT || 'onlyvertex-474004', location: 'us-central1' });
const generativeModel = vertexAI.getGenerativeModel({model: 'gemini-2.5-pro'});

// --- LÓGICA DE GENERACIÓN DE INFORME (ahora vive aquí) ---
async function generarInformeDesdeJSON(datosFormularios) {
    const stringForm1 = datosFormularios.form1 ? JSON.stringify(datosFormularios.form1, null, 2) : '"No proporcionado."';
    const stringForm2 = datosFormularios.form2 ? JSON.stringify(datosFormularios.form2, null, 2) : '"No proporcionado."';
    const stringForm3 = datosFormularios.form3 ? JSON.stringify(datosFormularios.form3, null, 2) : '"No proporcionado."';
    
    let promptTemplate = process.env.PROMPT_GENERAR_INFORME;
    const nombreUnidad = datosFormularios.form1?.analisisOrganizacional?.nombreUnidad || 'Unidad No Especificada';
    const mesAnio = new Date().toLocaleString('es-ES', { month: 'long', year: 'numeric' });

    let finalPrompt = promptTemplate
        .replace('__NOMBRE_UNIDAD__', nombreUnidad)
        .replace('__MES_ANIO__', mesAnio.charAt(0).toUpperCase() + mesAnio.slice(1))
        .replace('__JSON_FORM_1__', stringForm1)
        .replace('__JSON_FORM_2__', stringForm2)
        .replace('__JSON_FORM_3__', stringForm3);

    console.log("[Report Gen Service] Enviando prompt final a Vertex AI...");
    const request = { contents: [{ role: 'user', parts: [{ text: finalPrompt }] }] };
    const result = await generativeModel.generateContent(request);
    return result.response.candidates[0].content.parts[0].text;
}

// --- ENDPOINT PRINCIPAL ---
router.post('/generar', protect, upload, async (req, res) => {
    const { chatId } = req.body;
    const files = req.files;
    if (!chatId) return res.status(400).json({ message: 'Se requiere un chatId.' });
    if (!files || Object.keys(files).length === 0) return res.status(400).json({ message: 'Se debe proporcionar al menos un archivo.' });

    let datosFormularios = {};
    let processedFiles = [];

    try {
        console.log(`[API /informes] Solicitud de informe con archivos recibida para Chat ID: ${chatId}`);
        const processingPromises = [];
        if (files.form1File) {
            const file = files.form1File[0];
            processedFiles.push(file);
            processingPromises.push(processAndFillForm(file, 'form1').then(json => datosFormularios.form1 = json));
        }
        if (files.form2File) {
            const file = files.form2File[0];
            processedFiles.push(file);
            processingPromises.push(processAndFillForm(file, 'form2').then(json => datosFormularios.form2 = json));
        }
        if (files.form3File) {
            const file = files.form3File[0];
            processedFiles.push(file);
            processingPromises.push(processAndFillForm(file, 'form3').then(json => datosFormularios.form3 = json));
        }
        await Promise.all(processingPromises);
        console.log("[API /informes] Extracción de JSON completada. Generando informe...");

        const generatedReportText = await generarInformeDesdeJSON(datosFormularios);
        const updatedChat = await Chat.findByIdAndUpdate(chatId, {
            $set: { 
                informeFinal: generatedReportText,
                formulario1Data: datosFormularios.form1 || null,
                formulario2Data: datosFormularios.form2 || null,
                formulario3Data: datosFormularios.form3 || null
            },
            $push: { messages: { $each: [
                { sender: 'user', text: 'Generar informe a partir de los archivos proporcionados.' },
                { sender: 'ai', text: generatedReportText }
            ] } }
        }, { new: true });

        if (!updatedChat) return res.status(404).json({ message: "Chat no encontrado." });
        console.log(`[API /informes] Informe y datos guardados para Chat ID: ${chatId}`);
        res.status(200).json({ updatedChat });

    } catch (error) {
        console.error('[API /informes] Error en el flujo:', error);
        await Chat.findByIdAndUpdate(chatId, { $push: { messages: { sender: 'bot', text: `Error al generar el informe: ${error.message}` } } });
        res.status(500).json({ message: 'Error en el servidor.', details: error.message });
    } finally {
        processedFiles.forEach(file => fs.existsSync(file.path) && fs.unlinkSync(file.path));
    }
});

module.exports = router;