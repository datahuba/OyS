// routes/chatRoutes.js

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Chat = require('../models/Chat');
const { protect } = require('../middleware/authMiddleware');
    
// --- RUTAS DEL CRUD DE CHATS ---

    // GET /api/chats - Listar todos los chats del usuario
    router.get('/', protect, async (req, res) => {
        try {
            const chats = await Chat.find({ userId: req.user._id }).select('_id title updatedAt').sort({ updatedAt: -1 });
            res.json(chats);
        } catch (error) { res.status(500).json({ message: 'Error al obtener chats', error: error.message }); }
    });

    // POST /api/chats - Crear un nuevo chat
    router.post('/', protect, async (req, res) => {
        // 1. Lee los datos opcionales que envía el frontend
        const { initialContext, title } = req.body;
    
        try {
            // 2. Actúa como un guardián: si se envía un contexto, lo valida primero.
            if (initialContext) {
                const validContexts = Chat.schema.path('activeContext').enumValues;
                if (!validContexts.includes(initialContext)) {
                    return res.status(400).json({ message: 'El contexto inicial proporcionado es inválido.' });
                }
            }
    
            // 3. Construye dinámicamente los datos del nuevo chat
            const chatData = {
                userId: req.user._id
            };
    
            if (title && typeof title === 'string' && title.trim()) {
                chatData.title = title.trim();
            }
    
            if (initialContext) {
                chatData.activeContext = initialContext;
            }
    
            // 4. Crea el chat con los datos preparados
            const newChat = new Chat(chatData);
            await newChat.save();
    
            res.status(201).json(newChat);
    
        } catch (error) {
            console.error("Error al crear un nuevo chat:", error);
            res.status(500).json({ message: 'Error del servidor al crear el chat', error: error.message });
        }
    });
    
    // GET /api/chats/:id - Obtener un chat específico
    router.get('/:id', protect, async (req, res) => {
    
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'ID de chat inválido' });
        try {
            const chat = await Chat.findOne({ _id: req.params.id, userId: req.user._id });
            if (!chat) return res.status(404).json({ message: 'Chat no encontrado o no autorizado' });
            res.json(chat);
        } catch (error) { res.status(500).json({ message: 'Error al obtener chat', error: error.message }); }
    });

    // DELETE /api/chats/:id - Eliminar un chat
    router.delete('/:id', protect, async (req, res) => {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'ID de chat inválido' });
        try {
            const chat = await Chat.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
            if (!chat) return res.status(404).json({ message: "Chat no encontrado o no autorizado" });
            res.json({ message: 'Chat eliminado exitosamente' });
        } catch (error) { res.status(500).json({ message: "Error interno al eliminar el chat." }); }
    });

    // PUT /api/chats/:id/title - Cambiar el título de un chat
    router.put('/:id/title', protect, async (req, res) => { // <-- El parámetro se llama ':id'
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
    // POST /api/chats/:chatId/context - Cambiar el contexto activo
    router.post('/:chatId/context', protect, async (req, res) => {
        const { chatId } = req.params;
        const { newContext } = req.body;
    
        // 1. VALIDACIÓN ROBUSTA (de mi versión)
        // Lee la lista de contextos válidos directamente desde el modelo de la base de datos.
        const validContexts = Chat.schema.path('activeContext').enumValues;
        if (!newContext || !validContexts.includes(newContext)) {
            return res.status(400).json({ message: 'Contexto inválido o no proporcionado.' });
        }
    
        try {
            const chat = await Chat.findById(chatId);
            if (!chat) {
                return res.status(404).json({ message: "Chat no encontrado." });
            }
    
            if (chat.activeContext === newContext) {
                return res.status(200).json({ 
                    message: "El contexto ya era el activo.",
                    updatedChat: chat 
                });
            }
    
            const updatedChat = await Chat.findByIdAndUpdate(chatId, {
                $set: { activeContext: newContext }
            }, { new: true });
    
            res.status(200).json({ updatedChat });
    
        } catch (error) {
            console.error("Error al cambiar el contexto explícitamente:", error);
            res.status(500).json({ message: "Error del servidor al cambiar el contexto." });
        }
    });

    // GET /api/chats/context/:contextName - Listar chats por contexto
    router.get('/context/:contextName', protect, async (req, res) => {
        const { contextName } = req.params;
    
        // A validação continua a ser uma boa prática
        const validContexts = [
            'chat', 'compatibilizacion', 'normativas', 'mof',
            'pyp', 'context6', 'context7', 'context8', 'miscellaneous'
        ];
    
        if (!validContexts.includes(contextName)) {
            return res.status(400).json({ message: 'Nombre de contexto inválido.' });
        }
    
        try {
            // --- ESTA É A LINHA QUE MUDA TUDO ---
            // A consulta agora é muito mais simples.
            const query = {
                userId: req.user._id,
                activeContext: contextName // Procura chats onde o campo 'activeContext' corresponda ao nome do contexto
            };
            
            // O resto do código permanece igual
            const chats = await Chat.find(query)
                .select('_id title updatedAt')
                .sort({ updatedAt: -1 });
    
            console.log(`Buscando chats para el contexto '${contextName}', encontrados: ${chats.length}`);
    
            res.status(200).json(chats);
    
        } catch (error) {
            console.error(`Error al obtener chats para el contexto '${contextName}':`, error);
            res.status(500).json({ message: 'Error del servidor al filtrar los chats.' });
        }
    });
    
    // --- RUTA DE LA API PARA OBTENER TODOS LOS CONTEXTOS DISPONIBLES ---
    router.get('/contexts', (req, res) => {
        try {
            // Extraemos solo los nombres de los contextos desde la configuración CONTEXT_TRIGGERS
            const availableContexts = CONTEXT_TRIGGERS.map(trigger => trigger.contextName);

            // Respondemos con la lista de contextos en formato JSON
            // Es una buena práctica devolver un objeto en lugar de un array directamente
            res.status(200).json({ contexts: availableContexts });

        } catch (error) {
            console.error("Error al obtener la lista de contextos:", error);
            res.status(500).json({ message: "Error del servidor al recuperar los contextos." });
        }
    });


module.exports = router;