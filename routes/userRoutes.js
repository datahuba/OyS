const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware'); 

const generateToken = (id, role) => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    // --- LÓGICA UNIFICADA PARA TODOS LOS USUARIOS ---
    // 1. Busca CUALQUIER usuario (admin o normal) en la BD por su email.
    //    .select('+password') es crucial para traer la contraseña para la comparación.
    const user = await User.findOne({ email }).select('+password');

    // 2. Valida si el usuario existe y si la contraseña coincide.
    if (user && (await user.matchPassword(password))) {
      // 3. Si es válido, responde con los datos REALES del usuario desde la BD.
      res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role, // <-- ¡CRÍTICO! El rol viene de la base de datos.
        token: generateToken(user._id, user.role), // <-- Se genera el token con el rol correcto.
      });
    } else {
      // 4. Si no es válido, envía un único mensaje de error genérico.
      res.status(401).json({ message: 'Email o contraseña inválidos' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Error del servidor', error: error.message });
  }
});


router.get('/profile', protect, async (req, res) => {
    res.status(200).json({
        _id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role
    });
});


/*  <--router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const userExists = await User.findOne({ email });
    if (userExists) return res.status(400).json({ message: 'El usuario ya existe' });
    const user = await User.create({ name, email, password });
    if (user) {
      res.status(201).json({
        _id: user._id,
        name: user.name,
        email: user.email,
        token: generateToken(user._id),
      });
    } else {
      res.status(400).json({ message: 'Datos de usuario inválidos' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Error del servidor', error: error.message });
  }
});*/  


module.exports = router;