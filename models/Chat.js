const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  sender: { type: String, required: true, enum: ['user', 'ai', 'bot'] },
  text: { type: String, required: true },
  error: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now },
}, { _id: false });

const chatSchema = new mongoose.Schema({
  title: { type: String, required: true, default: 'Nuevo Chat' },
  messages: [messageSchema],
  documentIds: {type: [String],default: []},
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('Chat', chatSchema);