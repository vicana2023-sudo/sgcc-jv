/* =============================================================================
   probar-reglas.mjs — comprobación del control de acceso a los datos
   ETUL 4 S.A.

   Ejecuta operaciones contra Firestore HACIÉNDOSE PASAR POR CADA ROL y dice si
   el servidor las permitió o las denegó. No usa el SDK de administración para
   leer y escribir —ese se salta las reglas por diseño y no probaría nada—: pide
   un token de sesión real para cada usuario y llama a la API REST con él,
   exactamente como haría el navegador.

   Por qué existe. La afirmación «el control de acceso es del servidor, no de la
   interfaz» es de las que un jurado pide demostrar, y enseñar el archivo de
   reglas no lo demuestra: demuestra la intención. Esto demuestra el efecto.
   Y de paso protege contra el error más fácil de cometer en este proyecto, que
   es tocar firestore.rules y darse cuenta tres semanas después.

   La comprobación que más importa es «el revisor NO puede alterar el hecho»:
   es la decisión 1 del diseño —el agente propone, nunca escribe— y la única
   que, si se rompiera, invalidaría el argumento de trazabilidad de la tesis.

   OJO al correrlo justo después de desplegar: las reglas tardan cerca de un
   minuto en propagarse, y mientras tanto TODO sale denegado. Si ve doce fallos
   seguidos, espere y repita antes de tocar nada.

   Uso:
     node probar-reglas.mjs

   Requiere admin/clave-servicio.json, igual que crear-usuarios.mjs.
   Deja el almacén como lo encontró: borra lo que crea.
============================================================================= */

import { readFileSync, existsSync } from "node:fs";
import { initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const { CONFIG_FIREBASE } = await import("../public/app/firebase-config.js");
const PROYECTO = CONFIG_FIREBASE.projectId;
const CLAVE_WEB = CONFIG_FIREBASE.apiKey;
const BASE = `https://firestore.googleapis.com/v1/projects/${PROYECTO}/databases/(default)/documents`;

const CLAVE_LOCAL = new URL("./clave-servicio.json", import.meta.url);
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) initializeApp({ credential: applicationDefault() });
else if (existsSync(CLAVE_LOCAL)) initializeApp({ credential: cert(JSON.parse(readFileSync(CLAVE_LOCAL, "utf8"))) });
else { console.error("Falta admin/clave-servicio.json. Ver LEEME.md."); process.exit(1); }

const auth = getAuth();

/* ------------------------- sesión real para un rol ------------------------
   createCustomToken + canje por idToken. El token resultante lleva los custom
   claims del usuario, así que las reglas ven el mismo `rol` que vería si la
   persona hubiera escrito su contraseña.                                     */
const tokens = new Map();
async function tokenDe(correo) {
  if (tokens.has(correo)) return tokens.get(correo);
  const u = await auth.getUserByEmail(correo);
  const custom = await auth.createCustomToken(u.uid);
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${CLAVE_WEB}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: custom, returnSecureToken: true }) });
  const j = await r.json();
  if (!j.idToken) throw new Error(`no se pudo abrir sesión como ${correo}: ${JSON.stringify(j.error || j)}`);
  const par = { idToken: j.idToken, uid: u.uid, rol: u.customClaims?.rol };
  tokens.set(correo, par);
  return par;
}

/* Firestore REST quiere los valores tipados. Solo se usan cadenas y números. */
const aCampos = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) =>
  [k, typeof v === "number" ? { integerValue: String(v) } : { stringValue: String(v) }]));

async function pedir(metodo, ruta, idToken, cuerpo) {
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: { Authorization: "Bearer " + idToken, "Content-Type": "application/json" },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  return { ok: r.ok, estado: r.status };
}

/* --------------------------------- pruebas -------------------------------- */
const ID = "PRUEBA-REGLAS-" + Date.now().toString(36);
let pasadas = 0, fallidas = 0;

async function comprobar(titulo, esperado, accion) {
  let real;
  try { real = (await accion()) ? "permitido" : "denegado"; }
  catch (e) { real = "error: " + e.message; }
  const bien = real === esperado;
  bien ? pasadas++ : fallidas++;
  console.log(`  ${bien ? "✓" : "✗"} ${titulo.padEnd(62)} ${real}${bien ? "" : `  (se esperaba ${esperado})`}`);
}

console.log(`\nControl de acceso en ${PROYECTO}\n${"=".repeat(78)}\n`);

const conductor = await tokenDe("conductor@etul4.pe");
const jefe = await tokenDe("mantenimiento@etul4.pe");
const operaciones = await tokenDe("operaciones@etul4.pe");
const investigador = await tokenDe("investigador@etul4.pe");

const propuesta = {
  estado: "ExtPropuesta", predicado: "etul:tipoComponente", objeto: "Frenos",
  fragmento: "el freno no respondió en la bajada", confianza: 0,
  origen: "prueba de reglas", creadoPor: conductor.uid, fecha: "2026-09-14",
};

console.log("Bandeja de revisión (/propuestas)");

await comprobar("el conductor crea una propuesta con evidencia", "permitido", async () =>
  (await pedir("POST", `/propuestas?documentId=${ID}`, conductor.idToken,
    { fields: aCampos(propuesta) })).ok);

await comprobar("…sin fragmento de evidencia, no puede", "denegado", async () => {
  const { fragmento, ...sinEvidencia } = propuesta;
  return (await pedir("POST", `/propuestas?documentId=${ID}-B`, conductor.idToken,
    { fields: aCampos(sinEvidencia) })).ok;
});

await comprobar("el jefe de mantenimiento lee la bandeja completa", "permitido", async () =>
  (await pedir("GET", "/propuestas", jefe.idToken)).ok);

await comprobar("el jefe de operaciones NO lee la bandeja", "denegado", async () =>
  (await pedir("GET", "/propuestas", operaciones.idToken)).ok);

await comprobar("el jefe de mantenimiento acepta la propuesta", "permitido", async () =>
  (await pedir("PATCH",
    `/propuestas/${ID}?updateMask.fieldPaths=estado&updateMask.fieldPaths=revisadoPor&updateMask.fieldPaths=revisadoEn`,
    jefe.idToken,
    { fields: aCampos({ estado: "ExtAceptada", revisadoPor: jefe.uid, revisadoEn: "2026-09-14 12:00" }) })).ok);

/* La comprobación que sostiene el argumento de la tesis. */
await comprobar("…pero NO puede alterar el hecho que aceptó", "denegado", async () =>
  (await pedir("PATCH", `/propuestas/${ID}?updateMask.fieldPaths=objeto`, jefe.idToken,
    { fields: aCampos({ objeto: "Transmision" }) })).ok);

await comprobar("…ni reescribir el fragmento de evidencia", "denegado", async () =>
  (await pedir("PATCH", `/propuestas/${ID}?updateMask.fieldPaths=fragmento`, jefe.idToken,
    { fields: aCampos({ fragmento: "otra cosa que el experto nunca dijo" }) })).ok);

await comprobar("el conductor NO puede aceptar su propio reporte", "denegado", async () =>
  (await pedir("PATCH", `/propuestas/${ID}?updateMask.fieldPaths=estado`, conductor.idToken,
    { fields: aCampos({ estado: "ExtAceptada" }) })).ok);

console.log("\nResultados de validación (/validacion)");

await comprobar("cada quien escribe sobre su propio documento", "permitido", async () =>
  (await pedir("PATCH", `/validacion/${jefe.uid}?updateMask.fieldPaths=prueba`, jefe.idToken,
    { fields: aCampos({ prueba: "si" }) })).ok);

await comprobar("nadie escribe sobre el veredicto de otro", "denegado", async () =>
  (await pedir("PATCH", `/validacion/${jefe.uid}?updateMask.fieldPaths=prueba`, operaciones.idToken,
    { fields: aCampos({ prueba: "manipulado" }) })).ok);

await comprobar("el investigador lee el consolidado", "permitido", async () =>
  (await pedir("GET", "/validacion", investigador.idToken)).ok);

/* Es la sonda con la que almacen.js decide si hay Firestore. Tiene que
   funcionar para el rol MÁS restringido, o el conductor creería estar
   guardando solo en su navegador cuando en realidad sí llega al servidor. */
await comprobar("el conductor lee su documento (sonda del almacén)", "permitido", async () =>
  (await pedir("GET", `/validacion/${conductor.uid}`, conductor.idToken)).estado !== 403);

console.log("\nConsultas de lista: las reglas validan, no filtran");

await comprobar("el conductor NO puede listar /sesiones sin restringir", "denegado", async () =>
  (await pedir("GET", "/sesiones", conductor.idToken)).ok);

console.log("\nColecciones no declaradas");

await comprobar("una colección sin reglas queda cerrada", "denegado", async () =>
  (await pedir("POST", "/inventada?documentId=x", investigador.idToken,
    { fields: aCampos({ a: "b" }) })).ok);

/* --------------------------------- limpieza ------------------------------- */
for (const ruta of [`/propuestas/${ID}`, `/propuestas/${ID}-B`, `/validacion/${jefe.uid}`]) {
  await pedir("DELETE", ruta, investigador.idToken);
}

console.log(`\n${"=".repeat(78)}`);
console.log(`${pasadas} de ${pasadas + fallidas} comprobaciones como se esperaba.`);
if (fallidas) {
  console.error("\nHay reglas que no hacen lo que dicen. No despliegue hasta corregirlo.");
  process.exit(1);
}
