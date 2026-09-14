/* =============================================================================
   firebase-config.js — identificadores públicos del proyecto
   ETUL 4 S.A.

   Esto NO es un secreto, y conviene tenerlo claro antes de que lo pregunten en
   la defensa. La apiKey de una app web de Firebase no es una credencial: es un
   identificador del proyecto, viaja en cada petición del navegador y cualquiera
   que abra el código fuente de la página la ve. Google la publica así a
   propósito y lo documenta.

   Lo que protege el sistema no es ocultar esta clave, sino:
     · que el proveedor de acceso exija correo y contraseña válidos,
     · que el rol sea un custom claim firmado por Google dentro del token, que
       el navegador puede leer pero no fabricar,
     · y, cuando haya datos reales, que las reglas del servidor decidan qué
       devuelve cada consulta.

   El secreto de verdad es la clave de la cuenta de servicio, que sirve para
   crear usuarios y firmar claims. Esa no está aquí ni en el repositorio: vive
   en el equipo del investigador y en los secretos de GitHub. Ver admin/LEEME.md.
============================================================================= */

export const CONFIG_FIREBASE = {
  apiKey: "AIzaSyDoCMYsXfD5mIteaQnkk2I9Oypid9SUilg",
  authDomain: "sgcc-jv.firebaseapp.com",
  projectId: "sgcc-jv",
  storageBucket: "sgcc-jv.firebasestorage.app",
  messagingSenderId: "239561470268",
  appId: "1:239561470268:web:bcbfaa1f198602bd6dee39",
};

/* Versión del SDK modular servido por Google. Se fija a propósito: un «latest»
   convertiría una actualización ajena en un fallo en producción el día de la
   defensa. */
export const SDK = "https://www.gstatic.com/firebasejs/11.1.0/";
