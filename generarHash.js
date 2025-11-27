const bcrypt = require('bcryptjs');

const password = 'OyS2025'; // La contraseña de tus administradores

bcrypt.genSalt(10, (err, salt) => {
  bcrypt.hash(password, salt, (err, hash) => {
    if (err) throw err;
    console.log('--- Contraseña a Hashear ---');
    console.log(password);
    console.log('\n--- COPIA ESTE HASH ---');
    console.log(hash);
    console.log('-------------------------');
  });
});