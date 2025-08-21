const mongoose = require('mongoose');

// ========================================================================
// 1. CENTRO DE CONFIGURACIÓN DE LÍMITES
// Para cambiar la cantidad máxima, solo tienes que editar los números aquí.
// Object.freeze asegura que estos valores no se modifiquen en otra parte.
// ========================================================================
const DOCUMENT_LIMITS = Object.freeze({
  COMPATIBILIZACION: 5,
  CONSOLIDADO_FACULTADES: 20,
  CONSOLIDADO_ADMINISTRATIVO: 1,
  MISCELLANEOUS: 10 
});


// ========================================================================
// 2. SUB-ESQUEMA PARA LOS DETALLES DEL DOCUMENTO
// Esta es la "plantilla" para la información de cada archivo que se guarda
// en MongoDB. Contiene los metadatos, pero NO los embeddings ni los chunks.
// ========================================================================
const documentDetailSchema = new mongoose.Schema({
  documentId: { type: String, required: true }, // El ID que enlaza con Pinecone
  originalName: { type: String, required: true }, // El nombre del archivo (ej: "reporte.pdf")
  uploadedAt: { type: Date, default: Date.now }, // La fecha de subida
  chunkCount: { type: Number, required: true } // Cuántos chunks se generaron
}, { _id: false }); // _id: false para no generar un ObjectId propio para cada objeto de documento.


// ========================================================================
// 3. SUB-ESQUEMA PARA LOS MENSAJES DEL CHAT
// ========================================================================
const messageSchema = new mongoose.Schema({
  sender: { type: String, required: true, enum: ['user', 'ai', 'bot'] },
  text: { type: String, required: true },
  error: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now },
}, { _id: false });


// ========================================================================
// 4. ESQUEMA PRINCIPAL DEL CHAT
// Este es el modelo principal que se guardará como un documento en tu colección de "chats".
// ========================================================================
const chatSchema = new mongoose.Schema({
  title: { 
    type: String, 
    required: true, 
    default: 'Nuevo Chat' 
  },
  messages: [messageSchema], // Un array de mensajes que siguen la plantilla messageSchema
  activeContext: {
    type: String,
    required: true,
    default: 'miscellaneous',
    enum: [ // enum asegura que solo estos valores son válidos
        'compatibilizacion', 
        'consolidadoFacultades', 
        'consolidadoAdministrativo', 
        'miscellaneous'
    ]
  },
  // --- ATRIBUTOS PARA CADA CATEGORÍA DE DOCUMENTOS ---
  // Cada uno es un atributo separado y es un array de 'documentDetailSchema'.
  compatibilizacion: {
    type: [documentDetailSchema],
    default: [],
    validate: {
      validator: v => v.length <= DOCUMENT_LIMITS.COMPATIBILIZACION,
      message: `Se ha excedido el límite de ${DOCUMENT_LIMITS.COMPATIBILIZACION} documentos para 'Compatibilización'.`
    }
  },
  consolidadoFacultades: {
    type: [documentDetailSchema],
    default: [],
    validate: {
      validator: v => v.length <= DOCUMENT_LIMITS.CONSOLIDADO_FACULTADES,
      message: `Se ha excedido el límite de ${DOCUMENT_LIMITS.CONSOLIDADO_FACULTADES} documentos para 'Consolidado Facultades'.`
    }
  },
  consolidadoAdministrativo: {
    type: [documentDetailSchema],
    default: [],
    validate: {
      validator: v => v.length <= DOCUMENT_LIMITS.CONSOLIDADO_ADMINISTRATIVO,
      message: `Se ha excedido el límite de ${DOCUMENT_LIMITS.CONSOLIDADO_ADMINISTRATIVO} documentos para 'Consolidado Administrativo'.`
    }
  },
  miscellaneous: {
    type: [documentDetailSchema],
    default: [],
    validate: {
      validator: v => v.length <= DOCUMENT_LIMITS.MISCELLANEOUS,
      message: `Se ha excedido el límite de ${DOCUMENT_LIMITS.MISCELLANEOUS} documentos para 'Misceláneos'.`
    }
  },

  // --- RELACIÓN CON EL USUARIO ---
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    required: true, 
    ref: 'User' // Esto crea una referencia al modelo de Usuario
  },
}, { timestamps: true }); // timestamps: true añade automáticamente los campos createdAt y updatedAt.

module.exports = mongoose.model('Chat', chatSchema);