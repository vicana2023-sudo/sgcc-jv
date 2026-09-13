/* =============================================================================
   comprobar-vistas.mjs — coherencia entre index.html y auth.js

   Tres cosas tienen que cuadrar y no hay nada que las obligue a cuadrar:

     · cada pestaña <button data-v="X"> necesita su <section id="v-X">
     · cada vista declarada en VISTAS necesita su pestaña
     · cada vista que un rol pide en PANEL_POR_ROL tiene que existir

   Si no cuadran, el rol afectado se queda con una pestaña que no abre nada, o
   con una sección inalcanzable. No falla al cargar: falla al cambiar de rol,
   que es justo cuando ya está en producción.

   Se ejecuta con Node, sin navegador. Lee el HTML con expresiones regulares
   en vez de un analizador porque la estructura es de este archivo concreto y
   añadir una dependencia a un proyecto sin dependencias no sale a cuenta.
============================================================================= */

import { readFileSync } from "node:fs";

const html = readFileSync("public/index.html", "utf8");
const errores = [];

const pestanas = [...html.matchAll(/<button[^>]*data-v="([^"]+)"/g)].map((m) => m[1]);
const secciones = [...html.matchAll(/<section[^>]*id="v-([^"]+)"/g)].map((m) => m[1]);

/* auth.js se importa de verdad: así se comprueba el módulo que se despliega,
   no una copia de sus valores que podría quedar desfasada. */
const auth = await import("../../public/app/auth.js");
const { VISTAS, PANEL_POR_ROL, CONSULTAS_POR_ROL, ROLES } = auth;

const vistas = Object.keys(VISTAS);

for (const p of pestanas) {
  if (!secciones.includes(p)) errores.push(`la pestaña «${p}» no tiene <section id="v-${p}">`);
  if (!vistas.includes(p)) errores.push(`la pestaña «${p}» no está declarada en VISTAS de auth.js`);
}
for (const s of secciones) {
  if (!pestanas.includes(s)) errores.push(`la sección «v-${s}» no tiene pestaña que la abra`);
}
for (const v of vistas) {
  if (!pestanas.includes(v)) errores.push(`VISTAS declara «${v}», que no existe como pestaña`);
}

for (const rol of ROLES) {
  const panel = PANEL_POR_ROL[rol.id];
  if (!panel) { errores.push(`el rol «${rol.id}» no tiene entrada en PANEL_POR_ROL`); continue; }
  for (const v of panel) {
    if (!vistas.includes(v)) errores.push(`el rol «${rol.id}» pide la vista «${v}», que no existe`);
  }
  if (!(rol.id in CONSULTAS_POR_ROL)) {
    errores.push(`el rol «${rol.id}» no tiene entrada en CONSULTAS_POR_ROL`);
  }
}

/* Los identificadores de consulta de cada rol tienen que existir en el
   catálogo. Un «Q31» de más no rompe nada visible: simplemente ese rol tiene
   una consulta menos de las que su autor creía darle. */
const { CONSULTAS } = await import("../../public/app/consultas.js");
const ids = CONSULTAS.map((c) => c.id);
for (const [rol, lista] of Object.entries(CONSULTAS_POR_ROL)) {
  if (lista === "*") continue;
  for (const q of lista) {
    if (!ids.includes(q)) errores.push(`el rol «${rol}» declara la consulta «${q}», que no está en el catálogo`);
  }
}

/* Las historias apuntan a vistas y a roles: si se reemplaza historias.json por
   la exportación del manual, este es el aviso de que algo no encaja. */
const historias = JSON.parse(readFileSync("public/datos/historias.json", "utf8"));
const idsRol = ROLES.map((r) => r.id);
for (const h of historias.historias) {
  if (h.vista && !vistas.includes(h.vista)) errores.push(`la historia ${h.id} apunta a la vista «${h.vista}», que no existe`);
  if (h.rol !== "todos" && !idsRol.includes(h.rol)) errores.push(`la historia ${h.id} apunta al rol «${h.rol}», que no existe`);
}

if (errores.length) {
  console.error("Incoherencias encontradas:\n" + errores.map((e) => "  · " + e).join("\n"));
  process.exit(1);
}

console.log(
  `OK   ${pestanas.length} pestañas, ${secciones.length} secciones, ` +
  `${ROLES.length} roles, ${CONSULTAS.length} consultas, ${historias.historias.length} historias`
);
