# Usar una imagen base de Node.js 18, ligera y estable.
FROM node:18-slim

# Crear un directorio de trabajo dentro del contenedor.
WORKDIR /app

# Copiar package.json y package-lock.json.
COPY package*.json ./

# Instalar solo las dependencias de producción de forma limpia.
RUN npm ci --only=production

# Copiar todo el resto del código de la aplicación.
COPY . .

# El puerto por defecto que Cloud Run usará.
EXPOSE 8080

# El comando para arrancar la aplicación.
CMD [ "npm", "start" ]