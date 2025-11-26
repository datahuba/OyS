const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware'); 

const generateToken = (id, role) => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

router.post('/register', async (req, res) => {
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
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    // --- 1. VERIFICACIÓN DE SUPERUSUARIOS PRIMERO ---
    // Comprueba si las credenciales coinciden con el SuperUsuario 1
    if (email === process.env.SUPER_USER1 && password === process.env.SUPER_PASSWORD1) {
      console.log('Login exitoso como Super Usuario 1');
      return res.json({
        _id: 'superuser_1', // Un ID estático para el superusuario
        name: 'Administrador Principal',
        email: process.env.SUPER_USER1,
        role: 'admin', // ¡El rol es importante!
        token: generateToken('superuser_1', 'super_admin'),
      });
    }

    // Comprueba si las credenciales coinciden con el SuperUsuario 2
    if (email === process.env.SUPER_USER2 && password === process.env.SUPER_PASSWORD2) {
      console.log('Login exitoso como Super Usuario 2');
      return res.json({
        _id: 'superuser_2',
        name: 'Administrador UAGRM',
        email: process.env.SUPER_USER2,
        role: 'admin',
        token: generateToken('superuser_2', 'admin'),
      });
    }

    // --- 2. FALLBACK A LA BASE DE DATOS PARA USUARIOS NORMALES ---
    // Si no es un superusuario, busca en la base de datos
    console.log('Credenciales no son de superusuario, buscando en la base de datos...');
    const user = await User.findOne({ email }).select('+password');

    if (user && (await user.matchPassword(password))) {
      res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        role: 'user', // Rol de usuario normal
        token: generateToken(user._id, 'user'),
      });
    } else {
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
    });
});

// PUT /api/users/profile
router.put('/profile', protect, async (req, res) => {
    const user = await User.findById(req.user._id);

    if (user) {
        user.name = req.body.name || user.name;
        user.email = req.body.email || user.email;
        if (req.body.password) {
            user.password = req.body.password;
        }
        const updatedUser = await user.save();
        res.json({
            _id: updatedUser._id,
            name: updatedUser.name,
            email: updatedUser.email,
            token: generateToken(updatedUser._id),
        });
    } else {
        res.status(404).json({ message: 'Usuario no encontrado' });
    }
});

// DELETE /api/users/profile
router.delete('/profile', protect, async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (user) {
            await user.deleteOne(); // O user.remove() en versiones antiguas de Mongoose
            res.json({ message: 'Usuario eliminado exitosamente' });
        } else {
            res.status(404).json({ message: 'Usuario no encontrado' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error del servidor', error: error.message });
    }
});

module.exports = router;