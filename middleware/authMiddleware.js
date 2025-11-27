const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Middleware de protección de rutas (versión unificada).
 * Verifica el token y adjunta el usuario desde la base de datos a req.user.
 */
const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      // 1. Extraer el token del encabezado
      token = req.headers.authorization.split(' ')[1];

      // 2. Verificar y decodificar el token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // 3. Buscar al usuario en la base de datos usando el ID del token
      //    Esta es la ÚNICA lógica que necesitamos, funciona para CUALQUIER rol.
      req.user = await User.findById(decoded.id).select('-password');

      // Si el token es válido pero el usuario ya no existe en la BD
      if (!req.user) {
        return res.status(401).json({ message: 'No autorizado, usuario no encontrado' });
      }

      // 4. Si todo es correcto, continuar a la siguiente función
      next();

    } catch (error) {
      console.error('Error de autenticación:', error.message);
      res.status(401).json({ message: 'No autorizado, el token falló' });
    }
  }

  // Si no se proporcionó ningún token
  if (!token) {
    res.status(401).json({ message: 'No autorizado, no hay token' });
  }
};

/**
 * Middleware para verificar si el usuario tiene rol de 'admin' o 'superadmin'.
 * No necesita cambios.
 */
const isAdmin = (req, res, next) => {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'superadmin')) {
    next();
  } else {
    res.status(403).json({ message: 'Acceso denegado. Se requiere rol de administrador.' });
  }
};

/**
 * Middleware para verificar si el usuario tiene rol de 'superadmin'.
 * No necesita cambios.
 */
const isSuperAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'superadmin') {
    next();
  } else {
    res.status(403).json({ message: 'Acceso denegado. Se requiere rol de Super Administrador.' });
  }
};

module.exports = {
  protect,
  isAdmin,
  isSuperAdmin
};