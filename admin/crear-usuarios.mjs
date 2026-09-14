/* =============================================================================
   crear-usuarios.mjs — alta de cuentas y asignación de roles
   ETUL 4 S.A.

   Esto es lo único que puede asignar un rol. El rol se graba como custom claim
   del usuario en Firebase Auth, firmado por Google: viaja dentro del token y el
   navegador puede leerlo pero no fabricarlo. Por eso el prototipo no necesita
   una tabla de permisos ni reglas de base de datos para que el rol sea de fiar.

   Se corre a mano, desde el equipo del investigador, con la clave de la cuenta
   de servicio. No forma parte del sitio ni se despliega: si estuviera en el
   navegador, cualquiera podría darse el rol que quisiera.

   Uso:
     node crear-usuarios.mjs              crea o actualiza las cuentas de usuarios.json
     node crear-usuarios.mjs --listar     muestra las cuentas y el rol de cada una
     node crear-usuarios.mjs --clave <correo>   genera una contraseña nueva para una cuenta

   Antes hace falta:
     1. npm install                       (en esta carpeta)
     2. la clave de la cuenta de servicio en admin/clave-servicio.json,
        o la variable GOOGLE_APPLICATION_CREDENTIALS apuntando a ella
     3. el proveedor «Correo y contraseña» habilitado en la consola de Firebase

   Ver LEEME.md, en esta misma carpeta.
============================================================================= */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const CLAVE_LOCAL = new URL("./clave-servicio.json", import.meta.url);
const SALIDA = new URL("./credenciales-generadas.txt", import.meta.url);

/* Los roles válidos se leen de auth.js, no se copian aquí. Duplicar la lista
   sería garantizar que un día alguien añada un rol en un sitio y no en el otro,
   y el síntoma sería una cuenta que entra y no ve nada. */
const { ROLES } = await import("../public/app/auth.js");
const IDS = ROLES.map((r) => r.id);

/* ------------------------------- conexión -------------------------------- */
function conectar() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return initializeApp({ credential: applicationDefault() });
  }
  if (existsSync(CLAVE_LOCAL)) {
    return initializeApp({ credential: cert(JSON.parse(readFileSync(CLAVE_LOCAL, "utf8"))) });
  }
  console.error(
    "No encuentro la clave de la cuenta de servicio.\n" +
    "Deje el JSON en admin/clave-servicio.json, o apunte GOOGLE_APPLICATION_CREDENTIALS a él.\n" +
    "Se descarga en: consola de Firebase → Configuración del proyecto → Cuentas de servicio."
  );
  process.exit(1);
}

/* Contraseña legible pero no adivinable: 4 grupos de 4, sin caracteres que se
   confundan al dictarla por teléfono (l/1/I, O/0). El investigador la entrega
   una vez y el usuario la cambia si quiere. */
function generarClave() {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const b = randomBytes(16);
  const c = [...b].map((n) => abc[n % abc.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12, 16)}`;
}

function anotar(linea) {
  const cab = existsSync(SALIDA) ? "" :
    "CREDENCIALES DEL PROTOTIPO ETUL 4\n" +
    "Este archivo no está en el repositorio (.gitignore). Entregue cada línea a\n" +
    "su destinatario y bórrelo cuando termine.\n" +
    "=".repeat(72) + "\n";
  appendFileSync(SALIDA, cab + linea + "\n", "utf8");
}

/* -------------------------------- acciones -------------------------------- */
async function listar(auth) {
  const r = await auth.listUsers(1000);
  if (!r.users.length) { console.log("No hay ninguna cuenta creada todavía."); return; }
  console.log(`${r.users.length} cuenta(s):\n`);
  for (const u of r.users) {
    const rol = u.customClaims?.rol;
    const marca = !rol ? "  ← SIN ROL: no podrá entrar"
                : !IDS.includes(rol) ? `  ← rol «${rol}» desconocido en auth.js`
                : "";
    console.log(`  ${(u.email || u.uid).padEnd(30)} ${(rol || "—").padEnd(20)}${marca}`);
  }
}

async function sincronizar(auth) {
  const cfg = JSON.parse(readFileSync(new URL("./usuarios.json", import.meta.url), "utf8"));
  let creadas = 0, actualizadas = 0;

  for (const u of cfg.usuarios) {
    if (!IDS.includes(u.rol)) {
      console.error(`  ✗ ${u.correo}: el rol «${u.rol}» no existe en auth.js (${IDS.join(", ")})`);
      continue;
    }
    let registro = null;
    try { registro = await auth.getUserByEmail(u.correo); } catch (e) { /* no existe */ }

    if (!registro) {
      const clave = generarClave();
      registro = await auth.createUser({
        email: u.correo, password: clave, displayName: u.nombre, emailVerified: true,
      });
      anotar(`${u.correo}\t${clave}\t${u.rol}`);
      console.log(`  + ${u.correo.padEnd(30)} creada, rol ${u.rol} · contraseña en credenciales-generadas.txt`);
      creadas++;
    } else if (registro.customClaims?.rol !== u.rol || registro.displayName !== u.nombre) {
      await auth.updateUser(registro.uid, { displayName: u.nombre });
      console.log(`  ~ ${u.correo.padEnd(30)} rol: ${registro.customClaims?.rol || "—"} → ${u.rol}`);
      actualizadas++;
    } else {
      console.log(`  = ${u.correo.padEnd(30)} sin cambios (${u.rol})`);
    }
    /* El claim se vuelve a escribir siempre: es barato y evita el caso de una
       cuenta creada a mano en la consola, que existiría sin rol. */
    await auth.setCustomUserClaims(registro.uid, { rol: u.rol });
  }

  console.log(`\n${creadas} creada(s), ${actualizadas} actualizada(s).`);
  if (creadas) {
    console.log(
      "\nLas contraseñas están en admin/credenciales-generadas.txt, que NO se sube al\n" +
      "repositorio. Entréguelas y borre el archivo cuando termine."
    );
  }
  console.log(
    "\nUn usuario con sesión abierta seguirá con su rol anterior hasta que su token\n" +
    "se renueve. La aplicación fuerza el refresco al cargar, así que basta con que\n" +
    "recargue la página."
  );
}

async function nuevaClave(auth, correo) {
  const u = await auth.getUserByEmail(correo);
  const clave = generarClave();
  await auth.updateUser(u.uid, { password: clave });
  anotar(`${correo}\t${clave}\t${u.customClaims?.rol || "—"}\t(restablecida)`);
  console.log(`Contraseña nueva para ${correo}, anotada en credenciales-generadas.txt`);
}

/* ---------------------------------- arranque ------------------------------ */
conectar();
const auth = getAuth();
const [cmd, arg] = process.argv.slice(2);

try {
  if (cmd === "--listar") await listar(auth);
  else if (cmd === "--clave") {
    if (!arg) { console.error("Falta el correo: node crear-usuarios.mjs --clave alguien@etul4.pe"); process.exit(1); }
    await nuevaClave(auth, arg);
  } else await sincronizar(auth);
} catch (e) {
  console.error("\nFalló:", e.message);
  if (String(e.message).includes("CONFIGURATION_NOT_FOUND")) {
    console.error(
      "Ese error suele significar que el proveedor «Correo y contraseña» no está\n" +
      "habilitado. Actívelo en la consola de Firebase → Authentication → Sign-in method."
    );
  }
  process.exit(1);
}
