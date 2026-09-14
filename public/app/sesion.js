/* =============================================================================
   sesion.js — acceso con correo y contraseña contra Firebase Auth
   ETUL 4 S.A.

   Esto sí es autenticación, a diferencia del desplegable que había antes. Quien
   entra demuestra que conoce una contraseña, y el rol con el que entra no lo
   elige: viene dentro del token, firmado por Google, como custom claim `rol`.
   El navegador puede leer ese claim; no puede fabricarlo ni cambiarlo.

   Los usuarios y sus roles los crea el investigador con el script de
   admin/crear-usuarios.mjs, que usa el SDK de administración. No hay registro
   abierto: nadie se da de alta solo. Es lo correcto para un sistema interno de
   una empresa de transporte, donde las cuentas las abre el área, no el usuario.

   LO QUE ESTO NO HACE, y hay que decirlo antes de que lo pregunten:
   Firebase Hosting sirve archivos de forma pública. El acceso protege la
   INTERFAZ, no los datos: cualquiera que conozca la ruta puede descargar
   datos/etul4_completa.ttl sin haber entrado nunca. Mientras el grafo sea
   ficticio da igual. El día que lleve datos reales de la empresa, el grafo
   tiene que salir de Hosting y pasar a un almacén con reglas del lado servidor
   —Firestore o Storage—, y las consultas ejecutarse allí.

   El SDK se carga con import() dinámico, no estático, por dos razones: para
   poder dar un mensaje decente si la red falla en vez de una página en blanco,
   y para que este módulo se pueda importar desde Node (las comprobaciones de
   integración del despliegue continuo lo hacen) sin intentar descargar nada.
============================================================================= */

import { CONFIG_FIREBASE, SDK } from "./firebase-config.js";

let auth = null;
let listo = false;
const oyentes = [];
let ultimo = null;          // { usuario, rol } o null

/* Mensajes en español para los códigos que el usuario puede provocar. Los que
   no están aquí salen con su código, que es lo que hace falta para depurar. */
const MENSAJES = {
  "auth/invalid-email": "El correo no tiene un formato válido.",
  "auth/missing-password": "Escriba su contraseña.",
  "auth/invalid-credential": "Correo o contraseña incorrectos.",
  "auth/wrong-password": "Correo o contraseña incorrectos.",
  "auth/user-not-found": "Correo o contraseña incorrectos.",
  "auth/user-disabled": "Esta cuenta está deshabilitada. Hable con el administrador.",
  "auth/too-many-requests": "Demasiados intentos fallidos. Espere unos minutos antes de reintentar.",
  "auth/network-request-failed": "No hay conexión con Firebase. Revise su red.",
  "auth/operation-not-allowed":
    "El proyecto de Firebase no tiene habilitado el acceso con correo y contraseña. " +
    "Actívelo en Authentication → Sign-in method.",
  /* Este no es culpa de quien entra: el proyecto todavía no tiene Authentication
     activado. Se deja con texto propio porque, sin él, el mensaje genérico manda
     a buscar una contraseña mal escrita que nunca fue el problema. */
  "auth/configuration-not-found":
    "Este proyecto de Firebase aún no tiene Authentication activado. " +
    "El administrador debe habilitarlo en la consola, en Authentication → Sign-in method → " +
    "Correo electrónico/contraseña.",
};

export function mensajeDeError(e) {
  const c = e && e.code ? e.code : "";
  return MENSAJES[c] || (c ? `No se pudo entrar (${c}).` : "No se pudo entrar.");
}

/**
 * Carga el SDK, conecta con Firebase y empieza a vigilar la sesión.
 * @param {(estado:{usuario:object,rol:string}|null)=>void} alCambiar
 * @returns {Promise<void>} rechaza si el SDK no se pudo cargar
 */
export async function arrancarSesion(alCambiar) {
  if (alCambiar) oyentes.push(alCambiar);
  if (listo) { avisar(ultimo); return; }

  const [{ initializeApp }, mod] = await Promise.all([
    import(SDK + "firebase-app.js"),
    import(SDK + "firebase-auth.js"),
  ]);
  const app = initializeApp(CONFIG_FIREBASE);
  auth = mod.getAuth(app);

  /* La sesión sobrevive al cierre del navegador. En un patio de buses, pedir la
     contraseña en cada recarga sería una razón para no usar el sistema. */
  try { await mod.setPersistence(auth, mod.browserLocalPersistence); } catch (e) { /* modo privado */ }

  guardar.entrar = (correo, clave) => mod.signInWithEmailAndPassword(auth, correo, clave);
  guardar.salir = () => mod.signOut(auth);

  mod.onAuthStateChanged(auth, async (u) => {
    listo = true;
    if (!u) { ultimo = null; avisar(null); return; }
    /* El claim se lee del token, no de un campo que el cliente pueda tocar.
       Se fuerza refresco por si al usuario le acaban de asignar el rol y su
       token todavía es el anterior. */
    let rol = null;
    try {
      const t = await u.getIdTokenResult(true);
      rol = t.claims.rol || null;
    } catch (e) { rol = null; }
    ultimo = { usuario: { uid: u.uid, correo: u.email, nombre: u.displayName || "" }, rol };
    avisar(ultimo);
  });
}

const guardar = { entrar: null, salir: null };

function avisar(estado) {
  oyentes.forEach((f) => { try { f(estado); } catch (e) { console.error(e); } });
}

/** Entra con correo y contraseña. Lanza el error de Firebase sin tocarlo. */
export async function entrar(correo, clave) {
  if (!guardar.entrar) throw new Error("La sesión todavía no está lista.");
  await guardar.entrar((correo || "").trim(), clave || "");
}

export async function salir() {
  if (guardar.salir) await guardar.salir();
}

export function sesionActual() { return ultimo; }
export function sesionLista() { return listo; }
