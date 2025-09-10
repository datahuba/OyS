const mongoose = require('mongoose');

const analisisSchema = new mongoose.Schema({
  // --- METADATOS DEL ANÁLISIS ---
  nombreAnalisis: {
    type: String,
    required: [true, 'El nombre del análisis es obligatorio.'],
    trim: true
  },
  unidadOrganizacional: { // A qué unidad pertenece este análisis
    type: String,
    required: [true, 'La unidad organizacional es obligatoria.'],
    index: true // Para buscar rápidamente todos los análisis de una unidad
  },
  userId: { // Qué usuario creó este análisis
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User'
  },
  estado: {
    type: String,
    enum: ['en_progreso', 'completado', 'archivado'],
    default: 'en_progreso'
  },

  // --- CONTENEDORES PARA LOS DATOS EXTRAÍDOS ---
  
  // Contendrá el JSON completo del Formulario 1
  formulario1Data: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  
  // Contendrá el JSON completo de los Formularios 2 (el objeto con la lista de puestos)
  formulario2Data: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },

  // Contendrá el JSON completo de los Formularios 3 (el objeto con la lista de procesos)
  formulario3Data: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  
  // --- RESULTADO FINAL ---
  informeFinal: {
    type: String, // Aquí guardaremos el informe de texto generado por la IA
    default: ''
  }

}, { timestamps: true }); // createdAt y updatedAt automáticos

module.exports = mongoose.model('Analisis', analisisSchema);