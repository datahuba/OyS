const mongoose = require('mongoose');



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
      default: 'miscellaneous', // El contexto general por defecto
      enum: [
          'compatibilizacionFacultades', 
          'consolidadoFacultades', 
          'compatibilizacionAdministrativo', 
          'consolidadoAdministrativo',
          'miscellaneous'
      ]
    },
   // --- NUEVO CAMPO PARA EL MODO SUPERUSUARIO ---
  isSuperuserMode: {
    type: Boolean,
    default: false
  },
  // --- ATRIBUTOS PARA CADA CATEGORÍA DE DOCUMENTOS ---
  // Cada uno es un atributo separado y es un array de 'documentDetailSchema'.
  compatibilizacionFacultades: {
    type: [documentDetailSchema],
    default: [],
  },
  consolidadoFacultades: {
    type: [documentDetailSchema],
    default: [],
  },
  compatibilizacionAdministrativo: {
    type: [documentDetailSchema],
    default: [],
  },
  consolidadoAdministrativo: {
    type: [documentDetailSchema],
    default: [],
  },
  miscellaneous: {
    type: [documentDetailSchema],
    default: [],
  },
formulario1Data: {
    type: mongoose.Schema.Types.Mixed, // 'Mixed' permite guardar cualquier objeto JSON
    default: null
  },
  formulario2Data: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  formulario3Data: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  // --- RELACIÓN CON EL USUARIO ---
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    required: true, 
    ref: 'User' // Esto crea una referencia al modelo de Usuario
  },

  
}, { timestamps: true }); // timestamps: true añade automáticamente los campos createdAt y updatedAt.

module.exports = mongoose.model('Chat', chatSchema);