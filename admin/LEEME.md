# Cuentas y roles del prototipo

Esta carpeta no se despliega. Son las herramientas del investigador para dar de alta las cuentas y asignarles su rol. Si esto estuviera en el navegador, cualquiera podría concederse el rol que quisiera.

---

## Cómo funciona el rol

El rol **no** vive en una tabla ni en el navegador: es un *custom claim* del usuario en Firebase Authentication. Google lo firma dentro del token de sesión. El navegador puede leerlo y actuar en consecuencia; no puede fabricarlo ni modificarlo.

Se eligió así, en vez de una colección de Firestore, por tres razones: no obliga a habilitar otra API, no fuerza a elegir una región que después no se puede cambiar, y es la forma canónica de control de acceso por roles en Firebase, que es lo que conviene poder citar.

El precio es que asignar un rol requiere el SDK de administración, es decir, este script.

---

## Antes de empezar, una sola vez

**1. Habilitar el acceso con correo y contraseña**

En la [consola de Firebase](https://console.firebase.google.com/project/sgcc-jv/authentication/providers): Authentication → Sign-in method → Correo electrónico/contraseña → Habilitar.

Sin esto, la aplicación responde `auth/configuration-not-found` y el script falla con `CONFIGURATION_NOT_FOUND`.

**2. Descargar la clave de la cuenta de servicio**

Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada. Guarde el JSON como `admin/clave-servicio.json`.

**Esa sí es una credencial de verdad**, a diferencia de la apiKey del navegador: quien la tenga puede crear usuarios y firmar roles. Está en `.gitignore`; no la suba, no la pegue en un chat y no la deje en una carpeta compartida.

**3. Instalar las dependencias**

```bash
cd admin && npm install
```

---

## Uso

Crear o actualizar todas las cuentas de `usuarios.json`:

```bash
node admin/crear-usuarios.mjs
```

Las contraseñas se generan solas y se anotan **una sola vez** en `admin/credenciales-generadas.txt`, que también está fuera del repositorio. Entregue cada línea a quien corresponda y borre el archivo.

Ver qué cuentas hay y con qué rol:

```bash
node admin/crear-usuarios.mjs --listar
```

Restablecer la contraseña de una cuenta:

```bash
node admin/crear-usuarios.mjs --clave conductor@etul4.pe
```

El script es idempotente: correrlo dos veces no duplica nada, y vuelve a escribir el claim siempre, para recoger también las cuentas creadas a mano en la consola, que nacerían sin rol.

---

## Cambiar el rol de alguien

Edite su `rol` en `usuarios.json` y vuelva a correr el script. El rol tiene que coincidir con un `id` de `ROLES` en `public/app/auth.js`; el script lo comprueba y se niega si no existe.

Quien tenga la sesión abierta seguirá con el rol anterior hasta que su token se renueve. La aplicación fuerza el refresco al cargar, así que basta con que recargue la página.

Si un claim quedara con un rol que `auth.js` no reconoce —porque se renombró en un sitio y no en el otro—, la aplicación no abre: cierra la sesión y lo dice en la pantalla de acceso. Es a propósito: entrar y no ver ningún módulo parecería un fallo del sistema cuando es un desajuste de administración.

---

## Lo que este acceso NO protege

Conviene tenerlo claro antes de la defensa, porque es la pregunta que sigue.

**Firebase Hosting sirve archivos de forma pública.** Cualquiera que conozca la ruta puede descargar `datos/etul4_completa.ttl` sin haber entrado nunca. El acceso protege la *interfaz*, no los *datos*.

Mientras el grafo sea ficticio, da igual. El día que lleve datos reales de la empresa, el grafo tiene que salir de Hosting y pasar a un almacén con reglas del lado del servidor —Firestore o Storage—, con las consultas ejecutándose allí y el mismo mapa `CONSULTAS_POR_ROL` aplicado antes de devolver ninguna fila.

Dicho de otro modo: lo que hay hoy es control de acceso a la interfaz con identidad verificada. No es control de acceso a los datos.
