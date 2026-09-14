/* =============================================================================
   almacen.js — dónde se guarda lo que produce el sistema
   ETUL 4 S.A.

   Un solo interfaz con dos implementaciones detrás:

     · Firestore, cuando el proyecto lo tiene habilitado y hay sesión. Los datos
       son compartidos y las reglas del servidor deciden quién ve qué.
     · localStorage, cuando no. Los datos se quedan en ese navegador.

   La diferencia no es un detalle de infraestructura, y conviene decirla tal
   cual en la defensa: con localStorage, LO QUE REPORTA UN CONDUCTOR NO LO VE EL
   JEFE DE MANTENIMIENTO. La cadena que dibuja el panel «qué pasa ahora con su
   reporte» describe un recorrido que, sin Firestore, no cruza de un navegador a
   otro. El flujo estaba bien pensado y mal sostenido.

   Por qué el respaldo local no se quita: el prototipo tiene que poder abrirse
   con `python -m http.server` y sin proyecto de Firebase, que es como se prueba
   y como se enseña en una máquina prestada. Degradar en silencio sería
   peligroso —alguien creería estar compartiendo datos y no—, así que el modo
   activo se expone y la interfaz lo dice.

   El SDK se carga con import() dinámico por la misma razón que en sesion.js:
   que un fallo de red dé un mensaje y no una página en blanco, y que este
   módulo se pueda importar desde Node sin intentar descargar nada.
============================================================================= */

import { CONFIG_FIREBASE, SDK } from "./firebase-config.js";

const PREFIJO = "etul4_";
let modo = "local";          // 'firestore' | 'local'
let motivo = "sin iniciar";
let fs = null;               // módulo de Firestore
let db = null;
let usuario = null;          // { uid, correo, rol }

/* El SDK de Firestore reintenta solo cuando no obtiene respuesta, y con la API
   deshabilitada eso significa que no rechaza NUNCA. Sin este límite, el arranque
   se quedaba esperando para siempre y la aplicación no pasaba de «cargando el
   grafo…». Un almacén que no contesta en unos segundos se da por ausente. */
const LIMITE_MS = 4000;
function conLimite(promesa, ms = LIMITE_MS) {
  return Promise.race([
    promesa,
    new Promise((_, rechazar) =>
      setTimeout(() => rechazar(new Error("tiempo-agotado")), ms)),
  ]);
}

export function modoAlmacen() { return modo; }
export function motivoAlmacen() { return motivo; }

/**
 * Intenta abrir Firestore; si no puede, se queda en el navegador.
 * Nunca lanza: un almacén compartido que falla no debe impedir trabajar.
 * @param {{uid:string, correo:string, rol:string}} u
 */
export async function abrirAlmacen(u) {
  usuario = u || null;
  if (!usuario) { modo = "local"; motivo = "sin sesión"; return modo; }
  try {
    const [{ initializeApp, getApps }, mod] = await Promise.all([
      import(SDK + "firebase-app.js"),
      import(SDK + "firebase-firestore.js"),
    ]);
    const app = getApps()[0] || initializeApp(CONFIG_FIREBASE);
    fs = mod;
    db = mod.getFirestore(app);
    /* Una lectura de prueba, acotada a un documento: es la única forma de saber
       si la API está habilitada y si las reglas dejan pasar a este rol. Que el
       SDK cargue no significa que haya base de datos al otro lado. */
    await conLimite(mod.getDocs(mod.query(mod.collection(db, "propuestas"), mod.limit(1))));
    modo = "firestore";
    motivo = "compartido entre usuarios";
  } catch (e) {
    modo = "local";
    const c = String((e && e.code) || e && e.message || e);
    motivo = c.includes("tiempo-agotado") ? "Firestore no respondió; probablemente no está habilitado"
           : c.includes("permission-denied") ? "las reglas no permiten leer a este rol"
           : c.includes("unavailable") || c.includes("not-found") || c.includes("NOT_FOUND")
             ? "Firestore no está habilitado en el proyecto"
           : `no se pudo abrir Firestore (${c.slice(0, 60)})`;
  }
  return modo;
}

/* --------------------------- respaldo en el navegador --------------------- */
const leerLocal = (col) => {
  try { return JSON.parse(localStorage.getItem(PREFIJO + col)) ?? {}; }
  catch (e) { return {}; }
};
const escribirLocal = (col, m) => {
  try { localStorage.setItem(PREFIJO + col, JSON.stringify(m)); } catch (e) {}
};

/* -------------------------------- operaciones ----------------------------- */

/** Devuelve todos los documentos visibles de una colección, como [{id, ...}]. */
export async function listar(col) {
  if (modo === "firestore") {
    try {
      const r = await conLimite(fs.getDocs(fs.collection(db, col)));
      return r.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (e) { /* cae al respaldo, abajo */ }
  }
  const m = leerLocal(col);
  return Object.entries(m).map(([id, d]) => ({ id, ...d }));
}

/** Crea o reemplaza un documento. Añade quién y cuándo, que las reglas exigen. */
export async function guardar(col, id, datos) {
  const doc = { ...datos, creadoPor: usuario ? usuario.uid : "local", creadoEn: new Date().toISOString() };
  if (modo === "firestore") {
    try { await conLimite(fs.setDoc(fs.doc(db, col, id), doc)); return doc; }
    catch (e) { console.warn("almacen: guardar en Firestore falló, se usa el navegador", e); }
  }
  const m = leerLocal(col);
  m[id] = doc;
  escribirLocal(col, m);
  return doc;
}

/**
 * Cambia campos de un documento existente.
 * En /propuestas las reglas solo dejan tocar estado, revisadoPor y revisadoEn:
 * cualquier otro campo se rechaza en el servidor, no aquí.
 */
export async function actualizar(col, id, cambios) {
  if (modo === "firestore") {
    try { await conLimite(fs.updateDoc(fs.doc(db, col, id), cambios)); return true; }
    catch (e) { console.warn("almacen: actualizar en Firestore falló", e); return false; }
  }
  const m = leerLocal(col);
  if (!m[id]) return false;
  m[id] = { ...m[id], ...cambios };
  escribirLocal(col, m);
  return true;
}

export async function borrar(col, id) {
  if (modo === "firestore") {
    try { await fs.deleteDoc(fs.doc(db, col, id)); return true; }
    catch (e) { return false; }
  }
  const m = leerLocal(col);
  delete m[id];
  escribirLocal(col, m);
  return true;
}

/** Vacía una colección. En Firestore solo lo permite el investigador. */
export async function vaciar(col) {
  if (modo === "firestore") {
    try {
      const r = await fs.getDocs(fs.collection(db, col));
      await Promise.all(r.docs.map((d) => fs.deleteDoc(d.ref)));
      return true;
    } catch (e) { return false; }
  }
  escribirLocal(col, {});
  return true;
}

/**
 * Avisa cuando la colección cambia. Con Firestore es en vivo —el jefe de
 * mantenimiento ve entrar el reporte del conductor sin recargar—; en el
 * navegador no hay nada que escuchar y devuelve una función vacía.
 * @returns {() => void} para dejar de escuchar
 */
export function escuchar(col, alCambiar) {
  if (modo !== "firestore") return () => {};
  try {
    return fs.onSnapshot(fs.collection(db, col), (r) => {
      alCambiar(r.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, (e) => console.warn("almacen: se cortó la escucha de " + col, e));
  } catch (e) { return () => {}; }
}

/** Identificador razonablemente único sin depender del servidor. */
export function nuevoId(prefijo = "DOC") {
  return `${prefijo}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
