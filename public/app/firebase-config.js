/* =============================================================================
   firebase-config.js — a qué proyecto de Firebase habla esta página
   ETUL 4 S.A.

   Hay dos ambientes y un solo código. El ambiente se deduce del dominio desde
   el que se sirve la página, no de una variable de compilación: este proyecto
   no tiene compilación, y aunque la tuviera, deducirlo del dominio hace
   imposible desplegar el paquete de calidad en producción por error.

     sgcc-jv.web.app        →  producción
     sgcc-jv-qa.web.app     →  calidad
     localhost              →  calidad, para no ensuciar producción probando

   ESTO NO ES UN SECRETO, y conviene tenerlo claro antes de que lo pregunten en
   la defensa. La apiKey de una app web de Firebase no es una credencial: es un
   identificador del proyecto, viaja en cada petición del navegador y cualquiera
   que abra el código fuente la ve. Google la publica así a propósito y lo
   documenta.

   Lo que protege el sistema no es ocultar esta clave, sino:
     · que el proveedor de acceso exija correo y contraseña válidos,
     · que el rol sea un custom claim firmado por Google dentro del token, que
       el navegador puede leer pero no fabricar,
     · y que las reglas del servidor decidan qué devuelve cada consulta.

   El secreto de verdad es la clave de la cuenta de servicio, que sirve para
   crear usuarios y firmar claims. Esa no está aquí ni en el repositorio: vive
   en el equipo del investigador y en los secretos de GitHub. Ver admin/LEEME.md.
============================================================================= */

const PROYECTOS = {
  produccion: {
    apiKey: "AIzaSyDoCMYsXfD5mIteaQnkk2I9Oypid9SUilg",
    authDomain: "sgcc-jv.firebaseapp.com",
    projectId: "sgcc-jv",
    storageBucket: "sgcc-jv.firebasestorage.app",
    messagingSenderId: "239561470268",
    appId: "1:239561470268:web:bcbfaa1f198602bd6dee39",
  },
  calidad: {
    apiKey: "AIzaSyD--emUYRycAbt_bDxSf3_8J6WLmrqQDJA",
    authDomain: "sgcc-jv-qa.firebaseapp.com",
    projectId: "sgcc-jv-qa",
    storageBucket: "sgcc-jv-qa.firebasestorage.app",
    messagingSenderId: "334245032771",
    appId: "1:334245032771:web:6539d26d4d5fa87d6e35f6",
  },
};

/* Producción solo cuando el dominio lo es. Cualquier otro sitio —calidad, un
   canal de vista previa, localhost, una copia abierta en otro dominio— cae en
   calidad. Es la dirección segura del error: como mucho se ensucia el ambiente
   de pruebas. */
function detectar() {
  const h = location.hostname;
  if (h === "sgcc-jv.web.app" || h === "sgcc-jv.firebaseapp.com") return "produccion";
  return "calidad";
}

export const AMBIENTE = detectar();
export const CONFIG_FIREBASE = PROYECTOS[AMBIENTE];

/** Para pintarlo en la cabecera: en calidad hay que saberlo a simple vista. */
export const ETIQUETA_AMBIENTE = AMBIENTE === "produccion" ? "" : "CALIDAD";

/* Versión del SDK modular servido por Google. Se fija a propósito: un «latest»
   convertiría una actualización ajena en un fallo en producción el día de la
   defensa. */
export const SDK = "https://www.gstatic.com/firebasejs/11.1.0/";
