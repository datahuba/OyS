const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { protect, isAdmin, isSuperAdmin } = require('../middleware/authMiddleware');

// === APLICAR MIDDLEWARE A TODAS LAS RUTAS DE ESTE ARCHIVO ===
// Esto asegura que solo los usuarios autenticados Y con rol de administrador
// puedan acceder a cualquiera de estos endpoints.
router.use(protect, isAdmin);


// -------------------------------------------------------------------
// --- ENDPOINTS PARA EL DASHBOARD DE GESTIÓN DE USUARIOS (CRUD) ---
// -------------------------------------------------------------------

/**
 * @route   GET /api/admin/users
 * @desc    (LEER) Obtener una lista de todos los usuarios
 * @access  Privado/Admin
 */
router.get('/users', async (req, res) => {
  try {
    // Busca todos los usuarios y excluye sus contraseñas de la respuesta
    const users = await User.find({}).select('-password');
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: 'Error del servidor al obtener la lista de usuarios.' });
  }
});

/**
 * @route   GET /api/admin/users/:id
 * @desc    (LEER) Obtener los detalles de un solo usuario por su ID
 * @access  Privado/Admin
 */
router.get('/users/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('-password');
        if (user) {
            res.json(user);
        } else {
            res.status(404).json({ message: 'Usuario no encontrado.' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Error del servidor al obtener el usuario.' });
    }
});


/**
 * @route   POST /api/admin/users
 * @desc    (CREAR) Crear un nuevo usuario desde el dashboard
 * @access  Privado/Admin
 */
router.post('/users', async (req, res) => {
  const { name, email, password, role } = req.body;

  try {
    // Verificar si el email ya está en uso
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: 'Ya existe un usuario con ese correo electrónico.' });
    }

    // Crear el nuevo usuario
    const user = await User.create({
      name,
      email,
      password, // El modelo se encargará de hashear esto automáticamente
      role: role || 'user', // El admin puede asignar un rol; si no, es 'user' por defecto
    });

    // Devolver el usuario creado (sin la contraseña)
    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error del servidor al crear el usuario.', error: error.message });
  }
});

/**
 * @route   PUT /api/admin/users/:id
 * @desc    (ACTUALIZAR) Modificar los datos de un usuario por su ID
 * @access  Privado/Admin
 */
router.put('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'Usuario no encontrado.' });
    }
    
    // Regla de negocio: Un admin no puede modificar a un superadmin
    if (user.role === 'superadmin' && req.user.role !== 'superadmin') {
        return res.status(403).json({ message: 'Solo un Super Administrador puede modificar a otro.'});
    }

    // Actualizar los campos que se envíen en el body
    user.name = req.body.name || user.name;
    user.email = req.body.email || user.email;
    user.role = req.body.role || user.role;
    
    // Si se envía una nueva contraseña, el modelo la hasheará
    if (req.body.password) {
      user.password = req.body.password;
    }

    const updatedUser = await user.save();

    res.json({
      _id: updatedUser._id,
      name: updatedUser.name,
      email: updatedUser.email,
      role: updatedUser.role,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error del servidor al actualizar el usuario.', error: error.message });
  }
});

/**
 * @route   DELETE /api/admin/users/:id
 * @desc    (ELIMINAR) Borrar un usuario por su ID
 * @access  Privado/SuperAdmin (¡Solo el rol más alto puede eliminar!)
 */
router.delete('/users/:id', isSuperAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'Usuario no encontrado.' });
    }
    
    // Regla de seguridad: Impedir que un superadmin se elimine a sí mismo
    if (user._id.toString() === req.user._id.toString()) {
        return res.status(400).json({ message: 'No puedes eliminar tu propia cuenta desde el panel de administración.' });
    }

    // Regla de seguridad: Un superadmin no puede eliminar a otro superadmin
    if (user.role === 'superadmin') {
      return res.status(403).json({ message: 'No se puede eliminar a otro Super Administrador.' });
    }

    await user.deleteOne();
    res.json({ message: 'Usuario eliminado exitosamente.' });

  } catch (error) {
    res.status(500).json({ message: 'Error del servidor al eliminar el usuario.' });
  }
});

module.exports = router;